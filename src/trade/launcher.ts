import { connectLocal, localOrigin, stopLocal } from './localConnection.js';

const stop = process.argv.includes('--stop');
const openExisting = process.argv.includes('--open-existing');
try {
  const connection = await connectLocal(!stop && !openExisting);
  if (stop) {
    await stopLocal(connection);
  } else {
    console.log(localOrigin + '/#' + connection.token);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
