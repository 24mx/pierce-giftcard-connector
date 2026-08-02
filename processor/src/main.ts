import * as dotenv from 'dotenv';
dotenv.config();

import { config } from './config/config';
import { setupFastify } from './server/server';

(async () => {
  const server = await setupFastify();

  const HOST = '0.0.0.0';
  try {
    await server.listen({
      port: config.port,
      host: HOST,
    });
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
})();
