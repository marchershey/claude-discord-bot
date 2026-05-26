module.exports = {
  apps: [{
    name: 'discord-bot',
    script: 'bot.js',
    env: {
      DISCORD_TOKEN: 'YOUR_DISCORD_BOT_TOKEN_HERE'
    },
    restart_delay: 5000,
    max_restarts: 10,
  }]
};
