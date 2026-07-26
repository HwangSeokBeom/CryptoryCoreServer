'use strict';

const serverCwd = process.env.CRYPTORY_SERVER_CWD || '/home/ec2-user/CryptoryCoreServer';

module.exports = {
  apps: [
    {
      name: 'cryptory-core-server',
      cwd: serverCwd,
      script: 'dist/index.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '1G',
      kill_timeout: 15000,
      listen_timeout: 10000,
      time: true,
      env_production: {
        NODE_ENV: 'production',
        PORT: '3000',
      },
    },
  ],
};
