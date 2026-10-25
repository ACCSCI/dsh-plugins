# GPU sampler for the DSH system-monitor plugin.
#
# Reads the Windows GPU performance counters through PDH directly (one query, kept
# open) and prints one line per sample on stdout:
#
#     <busy percent>|<dedicated MB>|<shared MB>
#
# The printed percentage is the busiest engine type, which is the reading Task
# Manager shows. Summing every per-process engine instance would double count the
# same hardware engine across processes.
#
# A start-up or query failure prints "err|<reason>" once and exits; the host half
# treats a missing line as "no GPU reading yet".

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::ASCII

$source = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class DshGpuSampler
{
    [DllImport("pdh.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
    static extern uint PdhOpenQueryW(string src, IntPtr userData, out IntPtr query);

    [DllImport("pdh.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
    static extern uint PdhAddEnglishCounterW(IntPtr query, string path, IntPtr userData, out IntPtr counter);

    [DllImport("pdh.dll", ExactSpelling = true)]
    static extern uint PdhCollectQueryData(IntPtr query);

    [DllImport("pdh.dll", ExactSpelling = true)]
    static extern uint PdhGetFormattedCounterArrayW(
        IntPtr counter, uint format, ref uint size, ref uint count, IntPtr buffer);

    [DllImport("pdh.dll", ExactSpelling = true)]
    static extern uint PdhCloseQuery(IntPtr query);

    // PDH_FMT_COUNTERVALUE: a DWORD status followed by an eight-byte-aligned
    // union. PDH_FMT_DOUBLE selects doubleValue, the only member read here.
    [StructLayout(LayoutKind.Sequential)]
    struct FmtValue
    {
        public uint status;
        public double value;
    }

    // PDH_FMT_COUNTERVALUE_ITEM_W: instance name pointer followed by the value.
    [StructLayout(LayoutKind.Sequential)]
    struct FmtItem
    {
        public IntPtr name;
        public FmtValue fmt;
    }

    const uint PDH_FMT_DOUBLE = 0x00000200;
    const uint PDH_MORE_DATA = 0x800007D2;

    static readonly int stride = Marshal.SizeOf(typeof(FmtItem));
    static readonly int nameOffset = (int)Marshal.OffsetOf(typeof(FmtItem), "name");
    static readonly int valueOffset = (int)Marshal.OffsetOf(typeof(FmtItem), "fmt")
        + (int)Marshal.OffsetOf(typeof(FmtValue), "value");

    static IntPtr query;
    static IntPtr engines;
    static IntPtr dedicated;
    static IntPtr shared;

    public static string Open()
    {
        uint status = PdhOpenQueryW(null, IntPtr.Zero, out query);
        if (status != 0) return "open:" + status;

        status = PdhAddEnglishCounterW(query, @"\GPU Engine(*)\Utilization Percentage", IntPtr.Zero, out engines);
        if (status != 0) return "engine-counter:" + status;

        // Adapter memory is optional: an older driver without the counter set
        // must not stop the utilization reading.
        PdhAddEnglishCounterW(query, @"\GPU Adapter Memory(*)\Dedicated Usage", IntPtr.Zero, out dedicated);
        PdhAddEnglishCounterW(query, @"\GPU Adapter Memory(*)\Shared Usage", IntPtr.Zero, out shared);

        PdhCollectQueryData(query);
        return "ok";
    }

    public static void Close()
    {
        if (query != IntPtr.Zero) PdhCloseQuery(query);
        query = IntPtr.Zero;
    }

    static bool ReadArray(IntPtr counter, out FmtItem[] items)
    {
        items = null;
        if (counter == IntPtr.Zero) return false;

        uint size = 0;
        uint count = 0;
        uint status = PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, ref size, ref count, IntPtr.Zero);
        if (status != PDH_MORE_DATA || size == 0) return false;

        IntPtr buffer = Marshal.AllocHGlobal((int)size);
        try
        {
            status = PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, ref size, ref count, buffer);
            if (status != 0) return false;
            if (count == 0 || count > 20000 || size < (uint)(count * stride)) return false;

            items = new FmtItem[count];
            for (uint i = 0; i < count; i++)
            {
                long at = (long)buffer + i * stride;
                items[i].name = Marshal.ReadIntPtr((IntPtr)at, nameOffset);
                items[i].fmt.value = (double)Marshal.PtrToStructure(
                    (IntPtr)(at + valueOffset), typeof(double));
            }
            return true;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    static string EngineType(string instance)
    {
        if (string.IsNullOrEmpty(instance)) return "other";
        int at = instance.LastIndexOf("engtype_", StringComparison.Ordinal);
        return at < 0 ? "other" : instance.Substring(at + 8);
    }

    static double Sum(IntPtr counter)
    {
        FmtItem[] items;
        if (!ReadArray(counter, out items)) return 0;
        double total = 0;
        foreach (var item in items) total += item.fmt.value;
        return total;
    }

    /// <summary>One formatted sample: busiest engine type, dedicated MB, shared MB.</summary>
    public static string Sample()
    {
        PdhCollectQueryData(query);

        double percent = 0;
        FmtItem[] enginesNow;
        if (ReadArray(engines, out enginesNow))
        {
            var perType = new Dictionary<string, double>();
            foreach (var item in enginesNow)
            {
                if (item.fmt.value <= 0) continue;
                string type = EngineType(Marshal.PtrToStringUni(item.name));
                double sum;
                perType.TryGetValue(type, out sum);
                perType[type] = sum + item.fmt.value;
            }
            foreach (var pair in perType)
            {
                if (pair.Value > percent) percent = pair.Value;
            }
        }

        if (percent > 100) percent = 100;

        return percent.ToString("F1", System.Globalization.CultureInfo.InvariantCulture)
            + "|" + (Sum(dedicated) / 1048576.0).ToString("F0", System.Globalization.CultureInfo.InvariantCulture)
            + "|" + (Sum(shared) / 1048576.0).ToString("F0", System.Globalization.CultureInfo.InvariantCulture);
    }
}
'@

try {
  Add-Type -TypeDefinition $source -Language CSharp
  $opened = [DshGpuSampler]::Open()
  if ($opened -ne 'ok') {
    [Console]::Out.WriteLine("err|$opened")
    [Console]::Out.Flush()
    exit 1
  }
} catch {
  [Console]::Out.WriteLine('err|compile')
  [Console]::Out.Flush()
  exit 1
}

# One second of warm-up: a rate counter needs two collections before it reports.
Start-Sleep -Milliseconds 1000

try {
  while ($true) {
    $line = $null
    try { $line = [DshGpuSampler]::Sample() } catch { $line = 'err|sample' }
    try {
      [Console]::Out.WriteLine($line)
      [Console]::Out.Flush()
    } catch {
      # A closed stdout means the Host that owns this sampler is gone.
      exit 0
    }
    Start-Sleep -Milliseconds 1500
  }
} finally {
  [DshGpuSampler]::Close()
}
