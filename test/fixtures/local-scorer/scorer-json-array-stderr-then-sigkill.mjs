process.stderr.write("[1,2,3]\n");
process.kill(process.pid, "SIGKILL");
