process.stderr.write("42\n");
process.kill(process.pid, "SIGKILL");
