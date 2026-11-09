' Runs the local price server with no window, and restarts it if it ever stops.
' Windows starts this from the Startup folder. To stop it: end "wscript.exe" and "node.exe" in Task Manager.
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "C:\dev\albion-recipe-book\server"
Do
  sh.Run """C:\Program Files\nodejs\node.exe"" server.mjs", 0, True
  WScript.Sleep 10000
Loop
