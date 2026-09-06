using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;

namespace PNP {
  public static class InstanceGuard {
    [StructLayout(LayoutKind.Sequential)] struct FT { public uint low, high; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(
      string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(
      IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(
      IntPtr process, out FT creation, out FT exit, out FT kernel, out FT user);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static void Emit(object value) { Console.Out.WriteLine(Json.Serialize(value)); Console.Out.Flush(); }
    static void Check(bool ok) { if (!ok) throw new InvalidOperationException("WIN32_" + Marshal.GetLastWin32Error()); }
    static IntPtr OpenExclusive(string value) {
      IntPtr handle=CreateFile(value, 0xC0000000, 0, IntPtr.Zero, 4, 0x80, IntPtr.Zero); // OPEN_ALWAYS, no sharing.
      if (handle == new IntPtr(-1)) throw new InvalidOperationException("INSTANCE_OWNED_" + Marshal.GetLastWin32Error());
      return handle;
    }
    public static void Run() {
      IntPtr recovery=IntPtr.Zero, gateway=IntPtr.Zero, target=IntPtr.Zero;
      try {
        string line=Console.ReadLine(); if (line==null) return;
        var input=Json.Deserialize<Dictionary<string,object>>(line);
        if (input==null || !input.ContainsKey("directory") || !input.ContainsKey("pid")) throw new InvalidOperationException("INVALID_GUARD_INPUT");
        string directory=input["directory"] as string;
        int pid=Convert.ToInt32(input["pid"]);
        if (String.IsNullOrEmpty(directory) || !System.IO.Path.IsPathRooted(directory) || pid<=0) throw new InvalidOperationException("INVALID_GUARD_INPUT");
        recovery=OpenExclusive(System.IO.Path.Combine(directory,"recovery.lock"));
        gateway=OpenExclusive(System.IO.Path.Combine(directory,"gateway.lock"));
        target=OpenProcess(0x00100000 | 0x0040 | 0x1000, false, (uint)pid);
        if (target==IntPtr.Zero) throw new InvalidOperationException("OWNER_PROCESS_UNAVAILABLE");
        FT created, exited, kernel, user; Check(GetProcessTimes(target,out created,out exited,out kernel,out user));
        IntPtr remoteRecovery, remoteGateway;
        Check(DuplicateHandle(GetCurrentProcess(),recovery,target,out remoteRecovery,0,false,2));
        Check(DuplicateHandle(GetCurrentProcess(),gateway,target,out remoteGateway,0,false,2));
        ulong creation=((ulong)created.high<<32)|created.low;
        Emit(new { ok=true, pid=pid, creationTime=creation.ToString() });
      } catch (Exception error) {
        Emit(new { ok=false, code=error.Message.StartsWith("INSTANCE_OWNED_") ? "INSTANCE_LOCKED" : "INSTANCE_GUARD_FAILED" });
      } finally {
        if (target!=IntPtr.Zero) CloseHandle(target);
        if (gateway!=IntPtr.Zero && gateway!=new IntPtr(-1)) CloseHandle(gateway);
        if (recovery!=IntPtr.Zero && recovery!=new IntPtr(-1)) CloseHandle(recovery);
      }
    }
  }
}
