import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

export async function listPobBuildFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(relative = ''): Promise<void> {
    const entries = await readdir(join(directory, relative), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name.startsWith('~~temp~~')) continue;
      const name = join(relative, entry.name);
      if (entry.isDirectory()) {
        await visit(name);
      } else if (entry.isFile() && /\.xml$/i.test(entry.name)) {
        files.push(name);
      }
    }
  }
  await visit();
  return files;
}
