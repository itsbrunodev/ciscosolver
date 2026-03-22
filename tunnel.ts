function pipeWithPrefix(
  stream: ReadableStream<Uint8Array> | null,
  prefix: string,
) {
  if (!stream) return;

  const reader = stream.getReader();
  const decoder = new TextDecoder();

  (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value);
      process.stdout.write(`[${prefix}] ${text}`);
    }
  })();
}

const proc1 = Bun.spawn(["bun", "run", "index.ts"], {
  stdout: "pipe",
  stderr: "pipe",
});

const proc2 = Bun.spawn(["cloudflared", "tunnel", "run", "ciscosolver"], {
  stdout: "pipe",
  stderr: "pipe",
});

pipeWithPrefix(proc1.stdout, "SOLVER");
pipeWithPrefix(proc1.stderr, "SOLVER");

pipeWithPrefix(proc2.stdout, "TUNNEL");
pipeWithPrefix(proc2.stderr, "TUNNEL");

proc1.exited.then(() => proc2.kill());
proc2.exited.then(() => proc1.kill());

await Promise.all([proc1.exited, proc2.exited]);
