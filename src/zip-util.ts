import yazl from "yazl";
import yauzl from "yauzl";

export interface ZipEntry {
  path: string;
  data: Buffer | Uint8Array | string;
}

export async function createZip(entries: ZipEntry[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zipFile = new yazl.ZipFile();
    const chunks: Buffer[] = [];

    zipFile.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zipFile.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zipFile.outputStream.on("error", (err: Error) => reject(err));

    for (const entry of entries) {
      let buf: Buffer;
      if (typeof entry.data === "string") {
        buf = Buffer.from(entry.data, "utf-8");
      } else if (Buffer.isBuffer(entry.data)) {
        buf = entry.data;
      } else {
        buf = Buffer.from(entry.data);
      }
      zipFile.addBuffer(buf, entry.path);
    }

    zipFile.end();
  });
}

export async function readZip(buffer: Buffer | Uint8Array): Promise<{ [path: string]: Buffer }> {
  return new Promise((resolve, reject) => {
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) return reject(err || new Error("Failed to open zip"));

      const files: { [path: string]: Buffer } = {};

      zipfile.readEntry();
      zipfile.on("entry", (entry) => {
        if (/\/$/.test(entry.fileName)) {
          zipfile.readEntry();
        } else {
          zipfile.openReadStream(entry, (streamErr, readStream) => {
            if (streamErr || !readStream) return reject(streamErr || new Error("Failed to open stream"));
            const chunks: Buffer[] = [];
            readStream.on("data", (chunk: Buffer) => chunks.push(chunk));
            readStream.on("end", () => {
              files[entry.fileName] = Buffer.concat(chunks);
              zipfile.readEntry();
            });
            readStream.on("error", (err) => reject(err));
          });
        }
      });

      zipfile.on("end", () => resolve(files));
      zipfile.on("error", (err) => reject(err));
    });
  });
}
