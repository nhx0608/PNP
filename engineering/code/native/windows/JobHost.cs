using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

namespace PNP {
  // A private supervisor owns the job handle. EOF or parent exit closes the job.
  // All protocol traffic is JSONL. No command line, environment or raw stderr is logged.
  public static class JobHost {
    [StructLayout(LayoutKind.Sequential)] struct SA { public int nLength; public IntPtr lpSecurityDescriptor; public int inherit; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct SI {
      public int cb; public string reserved; public string desktop; public string title;
      public int x,y,xSize,ySize,xCount,yCount,fill,flags; public short show,reserved2;
      public IntPtr reservedPtr, stdin, stdout, stderr;
    }
    [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr process, thread; public uint pid, tid; }
    [StructLayout(LayoutKind.Sequential)] struct BASIC {
      public long processTime, jobTime; public uint flags;
      public UIntPtr minWorking, maxWorking; public uint activeLimit;
      public UIntPtr affinity; public uint priority, scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IO {
      public ulong readOps, writeOps, otherOps, readBytes, writeBytes, otherBytes;
    }
    [StructLayout(LayoutKind.Sequential)] struct EXT {
      public BASIC basic; public IO io;
      public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] struct ACCOUNT {
      public long user, kernel, periodUser, periodKernel;
      public uint faults, total, active, terminated;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref EXT value, uint length);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int cls, ref ACCOUNT value, uint length, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SA attr, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref SI si, out PI pi);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 4 * 1024 * 1024 };
    static readonly object Output = new object();
    static void Emit(object value) { lock (Output) { Console.Out.WriteLine(Json.Serialize(value)); Console.Out.Flush(); } }
    static void Check(bool ok) { if (!ok) throw new InvalidOperationException("WIN32_" + Marshal.GetLastWin32Error()); }
    static string Quote(string value) {
      var b = new StringBuilder("\""); int slashes = 0;
      foreach (char c in value) {
        if (c == '\\') { slashes++; continue; }
        if (c == '"') b.Append('\\', slashes * 2 + 1); else b.Append('\\', slashes);
        b.Append(c); slashes = 0;
      }
      b.Append('\\', slashes * 2); return b.Append('"').ToString();
    }
    static FileStream Stream(IntPtr handle, FileAccess access) { return new FileStream(new SafeFileHandle(handle, true), access, 4096, false); }
    static Task Pump(Stream stream, string type) {
      return Task.Run(() => {
        byte[] bytes = new byte[8192]; int n;
        try { while ((n = stream.Read(bytes, 0, bytes.Length)) > 0) Emit(new { type = type, data = Convert.ToBase64String(bytes, 0, n) }); }
        catch (IOException) { }
        finally { stream.Dispose(); }
      });
    }
    static bool IsEmpty(IntPtr job) {
      ACCOUNT info = new ACCOUNT();
      Check(QueryInformationJobObject(job, 1, ref info, (uint)Marshal.SizeOf(typeof(ACCOUNT)), IntPtr.Zero));
      return info.active == 0;
    }
    public static void Run() {
      IntPtr job = IntPtr.Zero, environment = IntPtr.Zero;
      PI pi = new PI();
      IntPtr childIn=IntPtr.Zero, parentIn=IntPtr.Zero, parentOut=IntPtr.Zero, childOut=IntPtr.Zero, parentErr=IntPtr.Zero, childErr=IntPtr.Zero;
      try {
        string first = Console.ReadLine();
        if (first == null) return;
        var config = Json.Deserialize<Dictionary<string, object>>(first);
        if (config == null || !config.ContainsKey("operation") || !(config["operation"] is string)) throw new InvalidOperationException("INVALID_OPERATION");
        string operation = (string)config["operation"];
        if (operation != "launch" && operation != "inspect") throw new InvalidOperationException("INVALID_OPERATION");
        if (!config.ContainsKey("jobName") || !(config["jobName"] is string)) throw new InvalidOperationException("INVALID_JOB_NAME");
        string name = (string)config["jobName"];
        if (!name.StartsWith("Local\\PNP-", StringComparison.Ordinal)) throw new InvalidOperationException("INVALID_JOB_NAME");
        if (operation == "inspect") {
          job = OpenJobObject(4, false, name);
          int error = Marshal.GetLastWin32Error();
          if (job == IntPtr.Zero) { Emit(new { type="inspection", quiescent=(error==2), error=error, windowsSessionId=Process.GetCurrentProcess().SessionId }); return; }
          Emit(new { type="inspection", quiescent=IsEmpty(job), error=0, windowsSessionId=Process.GetCurrentProcess().SessionId }); return;
        }
        // Do not create a Job or process until the Node owner has durably recorded
        // the Windows object namespace in which this supervisor operates.
        Emit(new { type="prepared", windowsSessionId=Process.GetCurrentProcess().SessionId });
        string proceedLine=Console.ReadLine();
        var proceed=proceedLine==null ? null : Json.Deserialize<Dictionary<string,object>>(proceedLine);
        if (proceed==null || !proceed.ContainsKey("type") || (string)proceed["type"]!="proceed")
          throw new InvalidOperationException("LAUNCH_NOT_COMMITTED");
        job = CreateJobObject(IntPtr.Zero, name);
        if (job == IntPtr.Zero) throw new InvalidOperationException("CREATE_JOB_FAILED");
        if (Marshal.GetLastWin32Error() == 183) throw new InvalidOperationException("JOB_ALREADY_EXISTS");
        EXT limits = new EXT(); limits.basic.flags = 0x2000; // KILL_ON_JOB_CLOSE; no breakaway permission.
        Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(EXT))));
        SA attr = new SA { nLength=Marshal.SizeOf(typeof(SA)), inherit=1 };
        Check(CreatePipe(out childIn, out parentIn, ref attr, 0));
        Check(CreatePipe(out parentOut, out childOut, ref attr, 0));
        Check(CreatePipe(out parentErr, out childErr, ref attr, 0));
        Check(SetHandleInformation(parentIn, 1, 0)); Check(SetHandleInformation(parentOut, 1, 0)); Check(SetHandleInformation(parentErr, 1, 0));
        string executable = (string)config["executable"];
        if (!Path.IsPathRooted(executable) || !executable.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("ABSOLUTE_EXE_REQUIRED");
        var command = new StringBuilder(Quote(executable));
        foreach (object item in (System.Collections.IEnumerable)config["args"]) command.Append(' ').Append(Quote((string)item));
        var values = (Dictionary<string, object>)config["env"];
        var names = new List<string>(values.Keys); names.Sort(StringComparer.OrdinalIgnoreCase);
        var block = new StringBuilder();
        foreach (string key in names) {
          string value = (string)values[key];
          if (key.IndexOf('=') >= 0 || key.IndexOf('\0') >= 0 || value.IndexOf('\0') >= 0) throw new InvalidOperationException("INVALID_ENVIRONMENT");
          block.Append(key).Append('=').Append(value).Append('\0');
        }
        block.Append('\0'); environment = Marshal.StringToHGlobalUni(block.ToString());
        SI startup = new SI { cb=Marshal.SizeOf(typeof(SI)), flags=0x100, stdin=childIn, stdout=childOut, stderr=childErr };
        // The root cannot execute or create descendants before membership is established.
        Check(CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, true, 0x4 | 0x400 | 0x08000000,
          environment, (string)config["cwd"], ref startup, out pi));
        if (!AssignProcessToJobObject(job, pi.process)) { TerminateProcess(pi.process, 1); throw new InvalidOperationException("ASSIGN_JOB_FAILED"); }
        CloseHandle(childIn); childIn=IntPtr.Zero; CloseHandle(childOut); childOut=IntPtr.Zero; CloseHandle(childErr); childErr=IntPtr.Zero;
        Check(ResumeThread(pi.thread) != UInt32.MaxValue);
        var stdin = Stream(parentIn, FileAccess.Write); parentIn=IntPtr.Zero;
        Task stdout = Pump(Stream(parentOut, FileAccess.Read), "stdout"); parentOut=IntPtr.Zero;
        Task stderr = Pump(Stream(parentErr, FileAccess.Read), "stderr"); parentErr=IntPtr.Zero;
        IntPtr ownedJob=job;
        Task.Run(() => {
          try {
            string line;
            while ((line=Console.ReadLine()) != null) {
              var message=Json.Deserialize<Dictionary<string, object>>(line);
              if ((string)message["type"] == "terminate") break;
              if ((string)message["type"] != "write") throw new InvalidOperationException("INVALID_CONTROL");
              byte[] bytes=Convert.FromBase64String((string)message["data"]);
              stdin.Write(bytes, 0, bytes.Length); stdin.Flush();
            }
          } catch { }
          finally { TerminateJobObject(ownedJob, 1); stdin.Dispose(); }
        });
        int parentPid=Convert.ToInt32(config["parentPid"]);
        Task.Run(() => { try { Process.GetProcessById(parentPid).WaitForExit(); } catch { } TerminateJobObject(ownedJob, 1); });
        Emit(new { type="ready", pid=pi.pid, jobName=name, windowsSessionId=Process.GetCurrentProcess().SessionId });
        WaitForSingleObject(pi.process, UInt32.MaxValue);
        uint code; GetExitCodeProcess(pi.process, out code);
        // A root exit must not strand descendants waiting on inherited pipes.
        TerminateJobObject(job, code);
        DateTime deadline=DateTime.UtcNow.AddSeconds(10);
        while (!IsEmpty(job) && DateTime.UtcNow < deadline) Thread.Sleep(20);
        bool drained=Task.WaitAll(new Task[] { stdout, stderr }, 2000);
        Emit(new { type="exit", code=code, quiescent=IsEmpty(job), drained=drained });
      } catch (Exception error) {
        if (pi.process != IntPtr.Zero) TerminateProcess(pi.process, 1);
        if (job != IntPtr.Zero) TerminateJobObject(job, 1);
        Emit(new { type="error", code="HOST_FAILURE", message=error.GetType().Name });
      } finally {
        if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
        foreach (IntPtr h in new IntPtr[] {childIn,parentIn,parentOut,childOut,parentErr,childErr,pi.thread,pi.process,job}) if (h != IntPtr.Zero) CloseHandle(h);
      }
    }
  }
}
