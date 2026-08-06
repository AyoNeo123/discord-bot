
require('dotenv').config({ path: 'c:/Users/User/OneDrive/Desktop/discord bot/discord-bot/.env' });
const { Client, GatewayIntentBits } = require('discord.js');
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

client.once('ready', async () => {
    try {
        const channel = await client.channels.fetch('1306995175494651977');
        const messages = await channel.messages.fetch({ limit: 10 });
        messages.forEach(msg => {
            console.log('Author:', msg.author.username, 'Content:', msg.content);
        });
    } catch(e) { console.error(e); }
    process.exit(0);
});
client.login(process.env.DISCORD_TOKEN);
