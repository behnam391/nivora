# Nivora for Windows

Portable Windows client for Nivora subscriptions. It signs in with the customer account, retrieves active subscriptions, launches the bundled Xray core, and turns on the Windows system proxy.

Supported in this first release: VLESS links, including Reality/TCP, gRPC and WebSocket. It uses the Windows proxy mode, not a TUN driver, so applications that explicitly bypass the system proxy are outside this first release.

Build from a Windows developer command prompt:

```powershell
C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /target:winexe /out:Nivora.exe /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Net.Http.dll /r:System.Web.Extensions.dll /r:System.Security.dll Program.cs
```
