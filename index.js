require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder, Partials, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ChannelType, PermissionFlagsBits, UserSelectMenuBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { Groq } = require('groq-sdk');

const TICKET_COUNTS_FILE = path.join(__dirname, 'ticket-counts.json');
function getNextTicketNumber(type) {
    let counts = { general: 0, partner: 0, media: 0, giveaway: 0 };
    if (fs.existsSync(TICKET_COUNTS_FILE)) {
        try {
            counts = JSON.parse(fs.readFileSync(TICKET_COUNTS_FILE, 'utf8'));
        } catch(e) {
            console.error('Error reading ticket counts:', e);
        }
    }
    
    if (counts[type] === undefined) {
        counts[type] = 0;
    }
    
    counts[type]++;
    
    try {
        fs.writeFileSync(TICKET_COUNTS_FILE, JSON.stringify(counts, null, 2));
    } catch(e) {
        console.error('Error writing ticket counts:', e);
    }
    
    return String(counts[type]).padStart(4, '0');
}

// --- GIVEAWAY HELPERS ---
const GIVEAWAYS_FILE = path.join(__dirname, 'giveaways.json');

function loadGiveaways() {
    if (fs.existsSync(GIVEAWAYS_FILE)) {
        try {
            return JSON.parse(fs.readFileSync(GIVEAWAYS_FILE, 'utf8'));
        } catch(e) {
            console.error('Error reading giveaways:', e);
            return {};
        }
    }
    return {};
}

function saveGiveaways(data) {
    try {
        fs.writeFileSync(GIVEAWAYS_FILE, JSON.stringify(data, null, 2));
    } catch(e) {
        console.error('Error writing giveaways:', e);
    }
}

function parseDuration(timeStr) {
    const regex = /^(\d+)([smhd])$/;
    const match = timeStr.match(regex);
    if (!match) return null;
    
    const value = parseInt(match[1]);
    const unit = match[2];
    
    switch (unit) {
        case 's': return value * 1000;
        case 'm': return value * 60 * 1000;
        case 'h': return value * 60 * 60 * 1000;
        case 'd': return value * 24 * 60 * 60 * 1000;
        default: return null;
    }
}

const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY
});

// Create a new client instance
const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages
    ],
    partials: [Partials.Channel]
});

// When the client is ready, run this code (only once)
client.once('ready', () => {
    console.log(`Ready! Logged in as ${client.user.tag}`);
});

// Store warnings for users. Key: User ID, Value: Timestamp
const warnings = new Map();
const PROTECTED_USER_ID = '1187690305516994631';
const HELP_ROLE_ID = '1323180252666663043';
const TICKET_STAFF_ROLE_ID = '1373246947732885684';
const TICKET_CATEGORY_ID = '1322885511387545630';
const WARNING_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

const NORMAL_LOG_CHANNEL = '1397224089055133838';
const TICKET_LOG_CHANNEL = '1397224306702024828';
let WELCOME_CHANNEL_ID = '1322866497885835286';

const LIMITED_STAFF_ROLES = ['1261617213325049936', '1323180641302609962', '1373244072373911593'];

async function sendLog(channelId, embed) {
    try {
        const channel = await client.channels.fetch(channelId);
        if (channel && channel.isTextBased()) {
            await channel.send({ embeds: [embed] });
        }
    } catch (e) {
        console.error('Error sending log:', e);
    }
}

// Listen for messages
client.on('messageCreate', async message => {
    // Ignore messages from other bots
    if (message.author.bot) return;

    // --- DM FORWARDING LOGIC ---
    if (!message.guild) {
        // Find staff-chat in any of the guilds the bot is in
        let staffChannel = null;
        for (const guild of client.guilds.cache.values()) {
            const channel = guild.channels.cache.find(c => c.name === 'staff-chat');
            if (channel) {
                staffChannel = channel;
                break;
            }
        }

        if (staffChannel) {
            const dmEmbed = new EmbedBuilder()
                .setTitle(`New DM from ${message.author.tag}`)
                .setDescription(message.content || '*No text content*')
                .setFooter({ text: `User ID: ${message.author.id}` })
                .setColor('#0099ff')
                .setTimestamp();

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`dmreply_${message.author.id}`).setLabel('Reply').setStyle(ButtonStyle.Primary)
            );
            
            await staffChannel.send({ embeds: [dmEmbed], components: [row] });
        }
        
        // Since it's a DM, none of the guild-specific logic below should run
        return;
    }

    // --- AI CHAT LOGIC ---
    const isBotMentioned = message.mentions.has(client.user.id) || message.content.toLowerCase().includes('bunji bot');
    const isReplyToBot = message.reference && message.mentions.repliedUser && message.mentions.repliedUser.id === client.user.id;

    if (isBotMentioned || isReplyToBot) {
        await message.channel.sendTyping();

        try {
            // Remove the bot's mention from the prompt so it doesn't confuse the AI
            const prompt = message.content.replace(`<@${client.user.id}>`, '').replace(/bunji bot/gi, '').trim();

            // Check if user is admin
            const isAdmin = message.member && message.member.roles.cache.has('1261617213325049936');

            // Define tools only if the user is an admin
            const tools = isAdmin ? [
                {
                    type: "function",
                    function: {
                        name: "delete_user_messages",
                        description: "Delete the recent messages from a specific user in this channel.",
                        parameters: {
                            type: "object",
                            properties: {
                                userId: {
                                    type: "string",
                                    description: "The Discord user ID of the person whose messages should be deleted. If the prompt contains a mention like <@123456789>, extract the numeric ID 123456789."
                                }
                            },
                            required: ["userId"]
                        }
                    }
                },
                {
                    type: "function",
                    function: {
                        name: "add_user_role",
                        description: "Add a specific role to a user in the server.",
                        parameters: {
                            type: "object",
                            properties: {
                                userId: {
                                    type: "string",
                                    description: "The Discord user ID of the person to receive the role. (Extract the numeric ID)."
                                },
                                roleId: {
                                    type: "string",
                                    description: "The Discord role ID of the role to give. (Extract the numeric ID)."
                                }
                            },
                            required: ["userId", "roleId"]
                        }
                    }
                }
            ] : undefined;

            const chatMessages = [
                {
                    role: "system",
                    content: "You are a helpful and friendly Discord bot. Keep your answers concise." + (isAdmin ? " You have permission to use the delete_user_messages tool if the user asks you to delete messages from a specific user." : "")
                },
                {
                    role: "user",
                    content: prompt || "Hello!"
                }
            ];

            const chatCompletion = await groq.chat.completions.create({
                messages: chatMessages,
                model: "llama-3.3-70b-versatile",
                tools: tools,
                tool_choice: "auto",
            });

            const responseMessage = chatCompletion.choices[0]?.message;
            const toolCalls = responseMessage?.tool_calls;

            if (toolCalls && toolCalls.length > 0) {
                for (const toolCall of toolCalls) {
                    if (toolCall.function.name === 'delete_user_messages') {
                        const args = JSON.parse(toolCall.function.arguments);
                        // Clean up the user ID just in case the AI includes the <@ > wrappers
                        const targetUserId = args.userId.replace(/[^0-9]/g, '');
                        
                        try {
                            const fetchedMessages = await message.channel.messages.fetch({ limit: 100 });
                            const messagesToDelete = fetchedMessages.filter(m => m.author.id === targetUserId);
                            
                            if (messagesToDelete.size === 0) {
                                await message.channel.send(`I couldn't find any recent messages from user <@${targetUserId}> in this channel.`);
                            } else {
                                // true = filter old messages (older than 14 days)
                                await message.channel.bulkDelete(messagesToDelete, true); 
                                await message.channel.send(`Successfully deleted ${messagesToDelete.size} recent messages from <@${targetUserId}>.`);
                            }
                        } catch (err) {
                            console.error("Bulk delete error:", err);
                            try {
                                await message.channel.send("I encountered an error trying to delete those messages. Make sure I have 'Manage Messages' permission.");
                            } catch (fallbackErr) {
                                console.error("Could not send fallback error message:", fallbackErr);
                            }
                        }
                    } else if (toolCall.function.name === 'add_user_role') {
                        const args = JSON.parse(toolCall.function.arguments);
                        const targetUserId = args.userId.replace(/[^0-9]/g, '');
                        const targetRoleId = args.roleId.replace(/[^0-9]/g, '');

                        try {
                            const member = await message.guild.members.fetch(targetUserId);
                            await member.roles.add(targetRoleId);
                            await message.channel.send(`Successfully added the role to <@${targetUserId}>.`);
                        } catch (err) {
                            console.error("Add role error:", err);
                            try {
                                await message.channel.send(`I encountered an error trying to add that role. Make sure the user/role is valid, and my bot's role is positioned higher in the server settings than the role I'm trying to assign!`);
                            } catch (fallbackErr) {}
                        }
                    }
                }
            } else {
                // Just a normal chat reply
                const replyContent = responseMessage?.content || "Sorry, I couldn't think of a response!";
                await message.reply(replyContent);
            }
        } catch (error) {
            console.error("Error with Groq API:", error);
            await message.reply("Sorry, my AI brain is currently experiencing issues!");
        }
        
        // Return early so we don't trigger the other keyword checks
        return;
    }

    // --- PING PROTECTION LOGIC ---
    // Check if the message is a reply to the protected user
    const isReplyToProtectedUser = message.reference && message.mentions.repliedUser && message.mentions.repliedUser.id === PROTECTED_USER_ID;

    // Only trigger if they pinged the user, AND it's not a direct reply to them
    if (message.mentions.has(PROTECTED_USER_ID) && !isReplyToProtectedUser) {
        // Attempt to delete the message
        try {
            await message.delete();
        } catch (error) {
            console.error("Failed to delete message. Make sure the bot has 'Manage Messages' permission.", error);
        }

        const now = Date.now();
        const userId = message.author.id;

        // Check if user was warned within the last 5 minutes
        if (warnings.has(userId) && (now - warnings.get(userId) < WARNING_WINDOW_MS)) {
            // Time them out
            try {
                await message.member.timeout(TIMEOUT_DURATION_MS, 'Pinged protected user twice within 5 minutes');
                message.channel.send(`<@${userId}>, you have been timed out for 30 minutes for repeatedly pinging the protected user.`);
                savePunishment(userId, 'TIMEOUT', 'Repeatedly pinging protected user', client.user.id, '30 minutes');
            } catch (error) {
                console.error("Failed to timeout user. Make sure the bot has 'Timeout Members' permission.", error);
                message.channel.send(`<@${userId}>, please stop pinging! *(I tried to time you out, but I am missing permissions!)*`);
            }
            // Clear the warning after timeout
            warnings.delete(userId);
        } else {
            // Warn them
            warnings.set(userId, now);
            message.channel.send(`<@${userId}>, please do not ping that user! If you need help, please ping <@&${HELP_ROLE_ID}> instead.`);
        }

        // Stop processing this message further
        return; 
    }

    // --- SLUR FILTER LOGIC ---
    const slurs = ['nigger', 'nga', 'nger', 'nigga', 'niga'];
    const lowerContent = message.content.toLowerCase();
    
    // Check if the message contains any of the slurs
    const containsSlur = slurs.some(slur => {
        // Use regex for word boundaries to avoid matching parts of innocent words, 
        // though for some slurs a direct include might be preferred if users bypass boundaries.
        // We'll do a simple direct check but ensure we catch the worst variants.
        return lowerContent.includes(slur);
    });

    if (containsSlur) {
        // Only try to kick if the user isn't an admin/bot owner
        if (message.member && !message.member.permissions.has('Administrator')) {
            try {
                await message.delete(); // Delete the message first
                await message.member.kick('Auto-kicked for using a slur.');
                
                // Try to notify the channel
                await message.channel.send(`User **${message.author.tag}** has been automatically kicked for using prohibited language.`);
                
                // Save this to the punishments database
                savePunishment(message.author.id, 'KICK', 'Auto-kicked for using a slur', client.user.id, null);
                
                return; // Stop processing this message
            } catch (error) {
                console.error("Failed to kick user for slur.", error);
            }
        }
    }

    // --- MEDIA/YOUTUBE REQUIREMENT LOGIC ---
    // Convert message to lowercase to make it case-insensitive
    const content = lowerContent;

    // Check if the message is talking about media or youtube roles
    const hasMediaOrYoutube = content.includes('media') || content.includes('youtube');

    if (hasMediaOrYoutube) {
        // 1. Asking for requirements
        if (content.includes('requirement') || content.includes('req')) {
            message.reply('The Media requirement is **YouTubers with 250+ subscribers** OR **Streamers with 50+ Followers on Twitch**. *(Note: Channel activity and content quality will also be taken into account!)*');
        } 
        // 2. Asking how to get the role
        else if (content.includes('how to get') || content.includes('give me') || content.includes('how do i get') || content.includes('can i get')) {
            message.reply('To apply, please create a media application ticket in <#1373240205821345882>');
        }
    }

    // --- STREAM SCHEDULE LOGIC ---
    if (content.includes('stream') || content.includes('schedule')) {
        const isAskingAboutStream = content.includes('when') || 
                                    content.includes('today') || 
                                    content.includes('time') ||
                                    content.includes('schedule') ||
                                    content.includes('no stream') || 
                                    content.includes('?') || 
                                    content.trim() === 'stream' || 
                                    content.trim() === 'streams';
                                    
        if (isAskingAboutStream) {
            message.reply('Bunji streams on **Tuesday, Thursday, Saturday, and Sunday** from **7 PM to 9 PM AEST**! Catch the stream here: https://www.youtube.com/@BunjiMC');
        }
    }
});

// --- DATABASE LOGIC ---
const dbPath = './punishments.json';
function loadPunishments() {
    if (!fs.existsSync(dbPath)) {
        fs.writeFileSync(dbPath, JSON.stringify({}));
    }
    return JSON.parse(fs.readFileSync(dbPath));
}

function savePunishment(userId, type, reason, moderatorId, duration = null) {
    const data = loadPunishments();
    if (!data[userId]) data[userId] = [];
    data[userId].push({
        type,
        reason,
        moderatorId,
        duration,
        timestamp: Date.now()
    });
    fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));

    const embed = new EmbedBuilder()
        .setTitle(`Punishment Log: ${type}`)
        .addFields(
            { name: 'User', value: `<@${userId}>`, inline: true },
            { name: 'Moderator', value: `<@${moderatorId}>`, inline: true },
            { name: 'Reason', value: reason || 'No reason provided' }
        )
        .setTimestamp()
        .setColor('#ff0000');
    if (duration) embed.addFields({ name: 'Duration', value: duration, inline: true });
    sendLog(NORMAL_LOG_CHANNEL, embed);
}

// --- GUIDE CONFIGURATION ---
const GUIDE_PAGES = [
    new EmbedBuilder()
        .setTitle('🛠️ Admin & Moderation Guide')
        .setDescription('**Welcome to the Bunji Bot Admin Guide!**\n\nThis guide covers all the moderation commands and automated systems designed to help you manage the server efficiently.\n\nUse the buttons below to navigate through the pages.')
        .addFields(
            { name: '`/punish`', value: 'Opens an interactive moderation menu for a user. You can warn, timeout, kick, or ban them directly from this menu.' },
            { name: '`/punish_history`', value: 'View the complete moderation history of a specific user. This shows all their past warnings, timeouts, kicks, and bans.' },
            { name: '`/purge`', value: 'Delete a large number of recent messages instantly. You can specify a channel, or even restrict it to a specific user.' },
            { name: '`/manage`', value: 'Manage a specific user. This gives you quick access to punish them or send them a direct message from the bot.' }
        )
        .setColor('#e74c3c')
        .setFooter({ text: 'Page 1/3' }),

    new EmbedBuilder()
        .setTitle('🎫 Ticket System Guide')
        .setDescription('The comprehensive ticket system allows users to securely contact staff for general support, partnership applications, media applications, and giveaway claims.')
        .addFields(
            { name: 'Ticket Setup', value: 'Use `/ticketsetup` in a channel to deploy the dropdown menu for users to create tickets.' },
            { name: 'Staff Panel', value: 'Inside every ticket, staff have access to a special "Staff Panel" button. This provides powerful ticket management tools.' },
            { name: 'Claim & Hold', value: 'Staff can **Claim** a ticket to indicate they are handling it, or put it on **Hold** if it requires further investigation.' },
            { name: 'Close vs Delete', value: 'Users can **Close** their ticket, which marks it as closed but keeps the channel. Staff can **Delete** (with a 10s confirmation) or **Silent Delete** (instant deletion).' },
            { name: 'Voice Channels', value: 'Need to speak? Use the Staff Panel to create a private Voice Channel perfectly synced with the ticket\'s permissions. It deletes automatically when the ticket is deleted.' },
            { name: 'Add User', value: 'Use the dropdown in the Staff Panel to quickly pull another user into the private ticket.' },
            { name: 'Logs', value: 'All ticket actions (creation, hold, close, delete, etc.) are logged automatically in <#1397224306702024828>.' }
        )
        .setColor('#2ecc71')
        .setFooter({ text: 'Page 2/3' }),

    new EmbedBuilder()
        .setTitle('🤖 Automation & AI Features')
        .setDescription('The bot operates a few background tasks to keep the server safe and engaging without manual intervention.')
        .addFields(
            { name: 'Auto-Slur Protection', value: 'If any user types a prohibited slur, the bot will automatically delete the message, kick the user immediately, and log the punishment in <#1397224089055133838>.' },
            { name: 'Ping Protection', value: 'To protect the owner from spam, the bot will warn anyone who pings them. If they ping them again within 5 minutes, they will be automatically timed out for 30 minutes.' },
            { name: 'AI Chatbot', value: 'You can ping the bot with a question, and it will use advanced AI to respond naturally and helpfully.' },
            { name: 'Auto-Responders', value: 'The bot automatically answers common questions about the stream schedule and media requirements.' }
        )
        .setColor('#9b59b6')
        .setFooter({ text: 'Page 3/3' })
];

function getGuideComponents(pageIndex) {
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('guide_prev').setLabel('Previous Page').setStyle(ButtonStyle.Primary).setDisabled(pageIndex === 0),
        new ButtonBuilder().setCustomId('guide_page_display').setLabel(`Page ${pageIndex + 1}/${GUIDE_PAGES.length}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
        new ButtonBuilder().setCustomId('guide_next').setLabel('Next Page').setStyle(ButtonStyle.Primary).setDisabled(pageIndex === GUIDE_PAGES.length - 1)
    );
    return [row];
}

// --- SLASH COMMAND REGISTRATION ---
const commands = [
    {
        name: 'punish',
        description: 'Open the moderation menu for a user',
        options: [
            {
                name: 'user',
                description: 'The user to moderate',
                type: 6, // USER type
                required: true
            }
        ]
    },
    {
        name: 'punish_history',
        description: 'View the moderation history of a user',
        options: [
            {
                name: 'user',
                description: 'The user to check',
                type: 6, // USER type
                required: true
            }
        ]
    },
    {
        name: 'purge',
        description: 'Delete a specified amount of messages',
        options: [
            {
                name: 'amount',
                description: 'The number of messages to delete',
                type: 4, // INTEGER
                required: true,
                min_value: 1,
                max_value: 100
            },
            {
                name: 'channel',
                description: 'The channel to purge messages from',
                type: 7, // CHANNEL
                required: false
            },
            {
                name: 'user',
                description: 'Only delete messages sent by this user',
                type: 6, // USER
                required: false
            }
        ]
    },
    {
        name: 'manage',
        description: 'Manage a specific user (Punish or send DM)',
        options: [
            {
                name: 'user',
                description: 'The user to manage',
                type: 6, // USER type
                required: true
            }
        ]
    },
    {
        name: 'help',
        description: 'Displays a list of all bot commands and features'
    },
    {
        name: 'ticketsetup',
        description: 'Send the ticket creation panel to the current channel (Admin only)'
    },
    {
        name: 'sendguide',
        description: 'Send the admin guide to the designated channel (Admin only)'
    },
    {
        name: 'testwelcome',
        description: 'Test the welcome message',
        options: [
            {
                name: 'user',
                description: 'The user to test with (defaults to you)',
                type: 6, // USER type
                required: false
            }
        ]
    },
    {
        name: 'giveaway',
        description: 'Start a giveaway (Staff only)'
    }
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

client.once('ready', async () => {
    try {
        console.log('Started refreshing application (/) commands.');
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commands },
        );
        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error(error);
    }
    
    // Check pending giveaways
    const giveaways = loadGiveaways();
    const now = Date.now();
    for (const [messageId, data] of Object.entries(giveaways)) {
        if (data.endTime <= now) {
            endGiveaway(messageId);
        } else {
            scheduleGiveaway(messageId, data.endTime);
        }
    }
});

// --- GIVEAWAY SCHEDULING ---
const giveawayTimers = new Map();

function scheduleGiveaway(messageId, endTime) {
    const delay = endTime - Date.now();
    if (delay <= 0) {
        endGiveaway(messageId);
        return;
    }
    
    const timeout = setTimeout(() => {
        endGiveaway(messageId);
    }, delay);
    
    giveawayTimers.set(messageId, timeout);
}

async function endGiveaway(messageId) {
    const giveaways = loadGiveaways();
    const data = giveaways[messageId];
    if (!data) return;
    
    giveawayTimers.delete(messageId);
    
    try {
        const channel = await client.channels.fetch(data.channelId).catch(() => null);
        if (!channel) throw new Error('Channel not found');
        
        const message = await channel.messages.fetch(messageId).catch(() => null);
        if (!message) throw new Error('Message not found');
        
        const participants = data.participants;
        let winners = [];
        
        if (participants.length > 0) {
            // Shuffle array
            const shuffled = [...participants].sort(() => 0.5 - Math.random());
            winners = shuffled.slice(0, Math.min(data.winnersCount, shuffled.length));
        }
        
        // Update embed
        const endedEmbed = EmbedBuilder.from(message.embeds[0])
            .setTitle(`🎉 GIVEAWAY ENDED 🎉`)
            .setColor('#2ecc71')
            .setDescription(`**Prize:** ${data.prize}\n${data.description}\n\n**Ended:** <t:${Math.floor(Date.now() / 1000)}:R>\n**Winners:** ${winners.length > 0 ? winners.map(id => `<@${id}>`).join(', ') : 'No valid entrants.'}`);
            
        // Disable buttons
        const newRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('gw_join').setLabel('Giveaway Ended').setStyle(ButtonStyle.Secondary).setDisabled(true)
        );
            
        await message.edit({ embeds: [endedEmbed], components: [newRow] });
        
        // Announce
        if (winners.length > 0) {
            await channel.send(`Congratulations ${winners.map(id => `<@${id}>`).join(', ')}! You won **${data.prize}**! 🎉`);
        } else {
            await channel.send(`The giveaway for **${data.prize}** ended, but no one participated! 😢`);
        }
        
    } catch (e) {
        console.error('Error ending giveaway:', e);
    }
    
    // Remove from DB
    delete giveaways[messageId];
    saveGiveaways(giveaways);
}

// --- INTERACTION LOGIC ---
client.on('interactionCreate', async interaction => {
    // 1. Slash Commands
    if (interaction.isChatInputCommand()) {
        const targetUser = interaction.options.getUser('user');

        if (interaction.commandName === 'punish') {
            const isFullAdmin = interaction.member.permissions.has('ModerateMembers');
            const hasLimitedRole = LIMITED_STAFF_ROLES.some(role => interaction.member.roles.cache.has(role));
            
            if (!isFullAdmin && !hasLimitedRole) {
                return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
            }
            
            const canBanAndDM = hasLimitedRole || interaction.member.id === interaction.guild?.ownerId;

            const embed = new EmbedBuilder()
                .setTitle(`Moderation Menu for ${targetUser.tag}`)
                .setDescription('Select an action to perform on this user.')
                .setColor('#ff0000');

            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder().setCustomId(`mod_warn_${targetUser.id}`).setLabel('Warn').setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId(`mod_timeout_${targetUser.id}`).setLabel('Timeout').setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId(`mod_kick_${targetUser.id}`).setLabel('Kick').setStyle(ButtonStyle.Danger),
                    new ButtonBuilder().setCustomId(`mod_ban_${targetUser.id}`).setLabel('Ban').setStyle(ButtonStyle.Danger).setDisabled(!canBanAndDM)
                );

            await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
        } 
        else if (interaction.commandName === 'punish_history') {
            // Check permissions
            if (!interaction.member.permissions.has('ModerateMembers') && !interaction.member.roles.cache.has('1261617213325049936')) {
                return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
            }

            const data = loadPunishments();
            const history = data[targetUser.id] || [];

            if (history.length === 0) {
                return interaction.reply({ content: `${targetUser.tag} has a clean record.`, ephemeral: true });
            }

            const embed = new EmbedBuilder()
                .setTitle(`Moderation History: ${targetUser.tag}`)
                .setColor('#ffa500');

            history.forEach((record, index) => {
                const date = new Date(record.timestamp).toLocaleDateString();
                let desc = `**Reason:** ${record.reason}\n**Moderator:** <@${record.moderatorId}>\n**Date:** ${date}`;
                if (record.duration) desc += `\n**Duration:** ${record.duration}`;
                embed.addFields({ name: `${index + 1}. ${record.type}`, value: desc });
            });

            await interaction.reply({ embeds: [embed], ephemeral: true });
        }
        else if (interaction.commandName === 'purge') {
            // Check permissions
            if (!interaction.member.permissions.has('ModerateMembers') && !interaction.member.roles.cache.has('1261617213325049936')) {
                return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
            }

            const amount = interaction.options.getInteger('amount');
            const targetChannel = interaction.options.getChannel('channel') || interaction.channel;
            const purgeUser = interaction.options.getUser('user');

            await interaction.deferReply({ ephemeral: true });

            try {
                // Fetch messages
                const fetched = await targetChannel.messages.fetch({ limit: 100 });
                let messagesToDelete = fetched;

                if (purgeUser) {
                    messagesToDelete = fetched.filter(m => m.author.id === purgeUser.id);
                }

                // Slice down to the exact amount requested
                const toDeleteArray = Array.from(messagesToDelete.values()).slice(0, amount);
                
                if (toDeleteArray.length === 0) {
                    return interaction.editReply(`Could not find any messages to delete matching those criteria.`);
                }

                await targetChannel.bulkDelete(toDeleteArray, true);
                
                let replyMsg = `Successfully deleted ${toDeleteArray.length} messages in <#${targetChannel.id}>.`;
                if (purgeUser) replyMsg += ` (Filtered by user <@${purgeUser.id}>)`;
                
                await interaction.editReply(replyMsg);
            } catch (err) {
                console.error("Purge error:", err);
                await interaction.editReply(`An error occurred while trying to purge messages: ${err.message}`);
            }
        }
        else if (interaction.commandName === 'giveaway') {
            const isFullAdmin = interaction.member.permissions.has('ModerateMembers');
            const hasLimitedRole = LIMITED_STAFF_ROLES.some(role => interaction.member.roles.cache.has(role));
            
            if (!isFullAdmin && !hasLimitedRole) {
                return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
            }
            
            const modal = new ModalBuilder()
                .setCustomId('modal_giveaway_setup')
                .setTitle('Giveaway Setup');
                
            const prizeInput = new TextInputBuilder()
                .setCustomId('prize')
                .setLabel('Prize to win')
                .setStyle(TextInputStyle.Short)
                .setRequired(true);
                
            const durationInput = new TextInputBuilder()
                .setCustomId('duration')
                .setLabel('Duration (e.g. 10m, 1h, 2d)')
                .setStyle(TextInputStyle.Short)
                .setRequired(true);
                
            const winnersInput = new TextInputBuilder()
                .setCustomId('winners')
                .setLabel('Number of winners (e.g. 1)')
                .setStyle(TextInputStyle.Short)
                .setRequired(true);
                
            const descriptionInput = new TextInputBuilder()
                .setCustomId('description')
                .setLabel('Giveaway Description')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true);
                
            modal.addComponents(
                new ActionRowBuilder().addComponents(prizeInput),
                new ActionRowBuilder().addComponents(durationInput),
                new ActionRowBuilder().addComponents(winnersInput),
                new ActionRowBuilder().addComponents(descriptionInput)
            );
            
            return interaction.showModal(modal);
        }
        else if (interaction.commandName === 'help') {
            const isAdmin = interaction.member.permissions.has('ModerateMembers') || interaction.member.roles.cache.has('1261617213325049936');

            const helpEmbed = new EmbedBuilder()
                .setTitle('Bunji Bot Help Menu')
                .setDescription('Here is a list of all my features and commands!')
                .setColor('#0099ff');

            if (isAdmin) {
                helpEmbed.addFields(
                    { name: '🛠️ Slash Commands (Admin Only)', value: '`/punish @User` - Opens a moderation menu to Warn, Timeout, Kick, or Ban.\n`/punish_history @User` - View a user\'s past moderation infractions.\n`/purge [amount]` - Bulk delete messages in a channel, optionally filtered by user.' },
                    { name: '🤖 AI Chat (Admin)', value: 'Mention the bot (`@Bunji Bot`) or include "bunji bot" in your message to chat with my AI! You can also ask the AI to **delete messages** or **assign roles** on your behalf.' }
                );
            } else {
                helpEmbed.addFields(
                    { name: '🤖 AI Chat', value: 'Mention the bot (`@Bunji Bot`) or include "bunji bot" in your message to chat with my AI!' }
                );
            }

            helpEmbed.addFields(
                { name: '🛡️ Ping Protection', value: 'Automatically deletes messages and warns/timeouts users who repeatedly ping the protected user.' },
                { name: '📺 Auto-Responders', value: 'Ask about the **stream schedule** or the **media requirement** and I will automatically provide the answer.' },
                { name: '📩 DM Forwarding', value: 'Any Direct Messages sent to me are securely forwarded to the staff team, where they can reply directly to you.' }
            )
            .setFooter({ text: 'Bunji Bot Features' })
            .setTimestamp();
            
            await interaction.reply({ embeds: [helpEmbed], ephemeral: true });
        }
        else if (interaction.commandName === 'manage') {
            const isFullAdmin = interaction.member.permissions.has('ModerateMembers');
            const hasLimitedRole = LIMITED_STAFF_ROLES.some(role => interaction.member.roles.cache.has(role));
            
            if (!isFullAdmin && !hasLimitedRole) {
                return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
            }
            
            const canBanAndDM = hasLimitedRole || interaction.member.id === interaction.guild?.ownerId;

            const targetUser = interaction.options.getUser('user');

            const embed = new EmbedBuilder()
                .setTitle(`Manage User: ${targetUser.tag}`)
                .setDescription('Select a management action for this user.')
                .setColor('#0099ff');

            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder().setCustomId(`mng_punish_${targetUser.id}`).setLabel('Punish User').setStyle(ButtonStyle.Danger),
                    new ButtonBuilder().setCustomId(`mng_dm_${targetUser.id}`).setLabel('Send Bot DM').setStyle(ButtonStyle.Primary).setDisabled(!canBanAndDM),
                    new ButtonBuilder().setCustomId(`mng_history_${targetUser.id}`).setLabel('History').setStyle(ButtonStyle.Secondary)
                );

            await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
        }
        else if (interaction.commandName === 'sendguide') {
            if (!interaction.member.permissions.has('ModerateMembers') && !interaction.member.roles.cache.has('1261617213325049936')) {
                return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
            }
            
            const targetChannel = await client.channels.fetch('1531914160592388157').catch(() => null);
            if (!targetChannel || !targetChannel.isTextBased()) {
                return interaction.reply({ content: 'Could not find the target channel or it is not a text channel.', ephemeral: true });
            }
            
            await interaction.deferReply({ ephemeral: true });
            await targetChannel.send({ embeds: [GUIDE_PAGES[0]], components: getGuideComponents(0) });
            return interaction.editReply('Guide sent successfully!');
        }
        else if (interaction.commandName === 'testwelcome') {
            if (!interaction.member.permissions.has('ModerateMembers') && !interaction.member.roles.cache.has('1261617213325049936')) {
                return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
            }
            
            const targetUser = interaction.options.getUser('user') || interaction.user;
            
            const welcomeEmbed = new EmbedBuilder()
                .setTitle(`Welcome to Bunji's Server! 🎉`)
                .setDescription(`Welcome <@${targetUser.id}>, we're glad to have you here! Make sure to read the rules and enjoy your stay.`)
                .setImage(targetUser.displayAvatarURL({ size: 512, extension: 'png' }))
                .setColor('#ff9900')
                .setTimestamp();
                
            await interaction.reply({ content: `Welcome <@${targetUser.id}> to Bunji's Server!`, embeds: [welcomeEmbed] });
        }
        else if (interaction.commandName === 'ticketsetup') {
            // Check permissions
            if (!interaction.member.permissions.has('ModerateMembers') && !interaction.member.roles.cache.has('1261617213325049936')) {
                return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
            }

            const embed = new EmbedBuilder()
                .setTitle('🎫  Welcome to Support')
                .setDescription('We\'re here to help! Please select the type of support you need from the dropdown menu below to open a ticket.\n\n**Categories:**\n📩 **General Ticket:** For general inquiries and support.\n🤝 **Partner Ticket:** Apply for a server partnership.\n📺 **Media Application:** Apply for a media role.\n🎉 **Giveaway Claim:** Claim a prize from a giveaway.')
                .setColor('#5865F2')
                .setFooter({ text: 'Our staff will be with you as soon as possible.' });

            const row = new ActionRowBuilder()
                .addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId('ticket_menu')
                        .setPlaceholder('Select a ticket category')
                        .addOptions(
                            new StringSelectMenuOptionBuilder()
                                .setLabel('General Ticket')
                                .setDescription('Open a general support ticket')
                                .setValue('ticket_general')
                                .setEmoji('📩'),
                            new StringSelectMenuOptionBuilder()
                                .setLabel('Partner Ticket')
                                .setDescription('Apply for partnership (40+ members req)')
                                .setValue('ticket_partner')
                                .setEmoji('🤝'),
                            new StringSelectMenuOptionBuilder()
                                .setLabel('Media Application')
                                .setDescription('Apply for media (250+ subs req)')
                                .setValue('ticket_media')
                                .setEmoji('📺'),
                            new StringSelectMenuOptionBuilder()
                                .setLabel('Giveaway Claim')
                                .setDescription('Claim a giveaway prize')
                                .setValue('ticket_giveaway')
                                .setEmoji('🎉')
                        )
                );

            await interaction.channel.send({ embeds: [embed], components: [row] });
            await interaction.reply({ content: 'Ticket panel sent!', ephemeral: true });
        }
    }

    // 2. String Select Menus
    else if (interaction.isStringSelectMenu()) {
        if (interaction.customId === 'ticket_menu') {
            const selected = interaction.values[0];

            if (selected === 'ticket_general') {
                const modal = new ModalBuilder()
                    .setCustomId('modalticket_general')
                    .setTitle('General Ticket');

                const reasonInput = new TextInputBuilder()
                    .setCustomId('reason')
                    .setLabel('Why are you creating this ticket?')
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(true);

                modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
                return interaction.showModal(modal);
            }
            else if (selected === 'ticket_partner') {
                const modal = new ModalBuilder()
                    .setCustomId('modalticket_partner')
                    .setTitle('Partner Application');

                const membersInput = new TextInputBuilder()
                    .setCustomId('members')
                    .setLabel('Do you meet the 40+ members req?')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true);

                const adInput = new TextInputBuilder()
                    .setCustomId('ad')
                    .setLabel('Paste your ad')
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(true);

                modal.addComponents(
                    new ActionRowBuilder().addComponents(membersInput),
                    new ActionRowBuilder().addComponents(adInput)
                );
                return interaction.showModal(modal);
            }
            else if (selected === 'ticket_media') {
                const modal = new ModalBuilder()
                    .setCustomId('modalticket_media')
                    .setTitle('Media Application');

                const subsInput = new TextInputBuilder()
                    .setCustomId('subs')
                    .setLabel('Do you meet the 250+ subs req?')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true);

                const linkInput = new TextInputBuilder()
                    .setCustomId('link')
                    .setLabel('Paste your YT channel link')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true);

                modal.addComponents(
                    new ActionRowBuilder().addComponents(subsInput),
                    new ActionRowBuilder().addComponents(linkInput)
                );
                return interaction.showModal(modal);
            }
            else if (selected === 'ticket_giveaway') {
                await interaction.deferReply({ ephemeral: true });
                
                const resetRow = new ActionRowBuilder().addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId('ticket_menu')
                        .setPlaceholder('Select a ticket category')
                        .addOptions(
                            new StringSelectMenuOptionBuilder().setLabel('General Ticket').setDescription('Open a general support ticket').setValue('ticket_general').setEmoji('📩'),
                            new StringSelectMenuOptionBuilder().setLabel('Partner Ticket').setDescription('Apply for partnership (40+ members req)').setValue('ticket_partner').setEmoji('🤝'),
                            new StringSelectMenuOptionBuilder().setLabel('Media Application').setDescription('Apply for media (250+ subs req)').setValue('ticket_media').setEmoji('📺'),
                            new StringSelectMenuOptionBuilder().setLabel('Giveaway Claim').setDescription('Claim a giveaway prize').setValue('ticket_giveaway').setEmoji('🎉')
                        )
                );
                interaction.message.edit({ components: [resetRow] }).catch(console.error);

                try {
                    const channel = await interaction.guild.channels.create({
                        name: `giveaway-${getNextTicketNumber('giveaway')}`,
                        type: ChannelType.GuildText,
                        parent: TICKET_CATEGORY_ID,
                        permissionOverwrites: [
                            {
                                id: interaction.guild.roles.everyone,
                                deny: [PermissionFlagsBits.ViewChannel],
                            },
                            {
                                id: interaction.user.id,
                                allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
                            },
                            {
                                id: TICKET_STAFF_ROLE_ID,
                                allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
                            }
                        ]
                    });

                    const mainEmbed = new EmbedBuilder()
                        .setTitle(`${interaction.user.username} - Giveaway Claim Ticket Panel`)
                        .setDescription('👋 Welcome! This is your Giveaway Claim ticket.\n✏️ Please describe your inquiry in as much detail as possible.\n🚫 Misuse of the ticket system may result in punishments.')
                        .setColor('#2ecc71');

                    const detailsEmbed = new EmbedBuilder()
                        .setTitle('Giveaway Claim')
                        .setDescription('User is claiming a giveaway.')
                        .setColor('#2F3136');

                    const buttonRow = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId('ticket_close').setLabel('Close Ticket').setEmoji('⛔').setStyle(ButtonStyle.Danger),
                        new ButtonBuilder().setCustomId('ticket_claim').setLabel('Claim Ticket').setEmoji('🙋‍♂️').setStyle(ButtonStyle.Success),
                        new ButtonBuilder().setCustomId('ticket_delete').setLabel('Delete Ticket').setEmoji('🗑️').setStyle(ButtonStyle.Secondary),
                        new ButtonBuilder().setCustomId('ticket_staffpanel').setLabel('Staff Panel').setEmoji('🔨').setStyle(ButtonStyle.Secondary)
                    );

                    await channel.send({
                        content: `<@${interaction.user.id}> Welcome, support will be with you shortly.\n**Staff has been notified, Please Wait**`,
                        embeds: [mainEmbed, detailsEmbed],
                        components: [buttonRow]
                    });

                    const logEmbed = new EmbedBuilder()
                        .setTitle('Ticket Created')
                        .addFields(
                            { name: 'Ticket', value: `<#${channel.id}>`, inline: true },
                            { name: 'User', value: `<@${interaction.user.id}>`, inline: true },
                            { name: 'Type', value: 'Giveaway Claim', inline: true }
                        )
                        .setTimestamp()
                        .setColor('#2ecc71');
                    sendLog(TICKET_LOG_CHANNEL, logEmbed);

                    const successEmbed = new EmbedBuilder()
                        .setTitle('Ticket Created! 🎉')
                        .setDescription(`Your ticket has been successfully created. Click here to view it: <#${channel.id}>`)
                        .setColor('#2ecc71');
                    return interaction.editReply({ content: '', embeds: [successEmbed] });
                } catch (error) {
                    console.error('Error creating ticket:', error);
                    return interaction.editReply({ content: 'There was an error creating your ticket.' });
                }
            }
        }
    }

    // 2.5 User Select Menus
    else if (interaction.isUserSelectMenu()) {
        if (interaction.customId === 'ticket_adduser') {
            if (!interaction.member.roles.cache.has(TICKET_STAFF_ROLE_ID) && !interaction.member.permissions.has('ModerateMembers')) {
                return interaction.reply({ content: 'You do not have permission to add users to this ticket.', ephemeral: true });
            }

            const selectedUserId = interaction.values[0];
            await interaction.deferUpdate();

            try {
                await interaction.channel.permissionOverwrites.edit(selectedUserId, {
                    ViewChannel: true,
                    SendMessages: true,
                    ReadMessageHistory: true
                });
                await interaction.channel.send(`<@${selectedUserId}> has been added to the ticket by <@${interaction.user.id}>.`);
                
                const logEmbed = new EmbedBuilder()
                    .setTitle('User Added to Ticket')
                    .addFields(
                        { name: 'Ticket', value: `<#${interaction.channel.id}>`, inline: true },
                        { name: 'Added User', value: `<@${selectedUserId}>`, inline: true },
                        { name: 'Moderator', value: `<@${interaction.user.id}>`, inline: true }
                    )
                    .setTimestamp()
                    .setColor('#3498db');
                sendLog(TICKET_LOG_CHANNEL, logEmbed);
            } catch (err) {
                console.error("Error adding user to ticket:", err);
            }
        }
    }

    // 3. Buttons
    else if (interaction.isButton()) {
        const parts = interaction.customId.split('_');

        if (parts[0] === 'guide') {
            const action = parts[1]; // 'prev' or 'next'
            const footerText = interaction.message.embeds[0].footer.text; // "Page X/Y"
            const match = footerText.match(/Page (\d+)\/(\d+)/);
            if (!match) return interaction.deferUpdate();
            
            let currentPage = parseInt(match[1]) - 1; // 0-indexed
            if (action === 'prev') currentPage = Math.max(0, currentPage - 1);
            else if (action === 'next') currentPage = Math.min(GUIDE_PAGES.length - 1, currentPage + 1);
            
            await interaction.update({
                embeds: [GUIDE_PAGES[currentPage]],
                components: getGuideComponents(currentPage)
            });
            return;
        }

        if (parts[0] === 'gw') {
            const action = parts[1];
            if (action === 'join') {
                const messageId = interaction.message.id;
                const giveaways = loadGiveaways();
                const data = giveaways[messageId];
                
                if (!data) {
                    return interaction.reply({ content: 'This giveaway has already ended or does not exist.', ephemeral: true });
                }
                
                if (data.participants.includes(interaction.user.id)) {
                    return interaction.reply({ content: 'You have already joined this giveaway!', ephemeral: true });
                }
                
                data.participants.push(interaction.user.id);
                saveGiveaways(giveaways);
                
                // Update the original message's second button
                const newRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('gw_join').setLabel('Join Giveaway 🎉').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId('gw_participants').setLabel(`Participants: ${data.participants.length}`).setStyle(ButtonStyle.Secondary).setDisabled(true)
                );
                
                await interaction.message.edit({ components: [newRow] });
                return interaction.reply({ content: 'You have successfully joined the giveaway! 🎉', ephemeral: true });
            }
        }

        if (parts[0] === 'ticket') {
            const action = parts[1];
            
            if (action === 'close') {
                await interaction.deferUpdate();
                
                const overwrites = interaction.channel.permissionOverwrites.cache;
                for (const [id, overwrite] of overwrites) {
                    if (overwrite.type === 1) { // 1 = Member (User)
                        await interaction.channel.permissionOverwrites.delete(id);
                    }
                }

                const closedRow = new ActionRowBuilder();
                if (interaction.message && interaction.message.components && interaction.message.components.length > 0) {
                    interaction.message.components[0].components.forEach(c => {
                        if (c.customId === 'ticket_close') {
                            closedRow.addComponents(new ButtonBuilder().setCustomId('ticket_close').setLabel('Closed').setEmoji('⛔').setStyle(ButtonStyle.Danger).setDisabled(true));
                        } else {
                            closedRow.addComponents(ButtonBuilder.from(c));
                        }
                    });
                }

                const closeEmbed = new EmbedBuilder()
                    .setTitle('Ticket Closed ⛔')
                    .setDescription(`This ticket was closed by <@${interaction.user.id}>.`)
                    .setColor('#e74c3c');
                await interaction.channel.send({ embeds: [closeEmbed] });
                
                const logEmbed = new EmbedBuilder()
                    .setTitle('Ticket Closed')
                    .addFields(
                        { name: 'Ticket', value: `<#${interaction.channel.id}>`, inline: true },
                        { name: 'Closed By', value: `<@${interaction.user.id}>`, inline: true }
                    )
                    .setTimestamp()
                    .setColor('#e74c3c');
                sendLog(TICKET_LOG_CHANNEL, logEmbed);

                if (closedRow.components.length > 0) {
                    return interaction.editReply({ components: [closedRow] });
                } else {
                    return interaction.editReply();
                }
            }
            else if (action === 'staffpanel') {
                if (!interaction.member.roles.cache.has(TICKET_STAFF_ROLE_ID) && !interaction.member.permissions.has('ModerateMembers')) {
                    return interaction.reply({ content: 'You do not have permission to use the Staff Panel.', ephemeral: true });
                }

                const embed = new EmbedBuilder()
                    .setDescription(`\`Claim ticket\` - Announce you will handle this ticket\n\`Hold ticket\` - Announces ticket is on hold and will be dealt with later\n\`Silent Delete\` - Instant deletion of the ticket (no warning)\n\`Delete Ticket\` - Prompts for confirmation then deletes in 10s\n\`Add to ticket\` - Add anyone from the drop down below`)
                    .setColor('#2F3136');

                const row1 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('ticket_claim').setLabel('Claim ticket').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId('ticket_hold').setLabel('Put on hold').setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId('ticket_silentdelete').setLabel('Silent Delete').setStyle(ButtonStyle.Danger),
                    new ButtonBuilder().setCustomId('ticket_delete').setLabel('Delete Ticket').setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId('ticket_vc').setLabel('Create Voice Channel').setStyle(ButtonStyle.Primary).setEmoji('🎤')
                );

                const row2 = new ActionRowBuilder().addComponents(
                    new UserSelectMenuBuilder()
                        .setCustomId('ticket_adduser')
                        .setPlaceholder('Select someone to add to the ticket')
                );

                return interaction.reply({ embeds: [embed], components: [row1, row2], ephemeral: true });
            }
            else if (action === 'claim') {
                if (!interaction.member.roles.cache.has(TICKET_STAFF_ROLE_ID) && !interaction.member.permissions.has('ModerateMembers')) {
                    return interaction.reply({ content: 'You do not have permission.', ephemeral: true });
                }
                
                const claimEmbed = new EmbedBuilder()
                    .setTitle('Ticket Claimed 🙋‍♂️')
                    .setDescription(`This ticket will be handled by <@${interaction.user.id}>.`)
                    .setColor('#2ecc71');
                await interaction.channel.send({ embeds: [claimEmbed] });
                
                const logEmbed = new EmbedBuilder()
                    .setTitle('Ticket Claimed')
                    .addFields(
                        { name: 'Ticket', value: `<#${interaction.channel.id}>`, inline: true },
                        { name: 'Claimed By', value: `<@${interaction.user.id}>`, inline: true }
                    )
                    .setTimestamp()
                    .setColor('#2ecc71');
                sendLog(TICKET_LOG_CHANNEL, logEmbed);
                
                const updatedRow = new ActionRowBuilder();
                if (interaction.message && interaction.message.components && interaction.message.components.length > 0) {
                    interaction.message.components[0].components.forEach(c => {
                        if (c.customId === 'ticket_claim') {
                            updatedRow.addComponents(new ButtonBuilder().setCustomId('ticket_claim').setLabel(`Claimed by ${interaction.user.username}`).setStyle(ButtonStyle.Success).setDisabled(true));
                        } else {
                            updatedRow.addComponents(ButtonBuilder.from(c));
                        }
                    });
                }
                
                if (interaction.message && interaction.message.components && interaction.message.components.length > 1) {
                    return interaction.update({ components: [updatedRow, interaction.message.components[1]] });
                } else if (updatedRow.components.length > 0) {
                    return interaction.update({ components: [updatedRow] });
                } else {
                    return interaction.update();
                }
            }
            else if (action === 'hold') {
                if (!interaction.member.roles.cache.has(TICKET_STAFF_ROLE_ID) && !interaction.member.permissions.has('ModerateMembers')) {
                    return interaction.reply({ content: 'You do not have permission.', ephemeral: true });
                }
                const holdEmbed = new EmbedBuilder()
                    .setTitle('Ticket On Hold ⏸️')
                    .setDescription(`This ticket has been placed on hold by <@${interaction.user.id}> and will be dealt with later.`)
                    .setColor('#3498db');
                    
                const logEmbed = new EmbedBuilder()
                    .setTitle('Ticket On Hold')
                    .addFields(
                        { name: 'Ticket', value: `<#${interaction.channel.id}>`, inline: true },
                        { name: 'Hold By', value: `<@${interaction.user.id}>`, inline: true }
                    )
                    .setTimestamp()
                    .setColor('#3498db');
                sendLog(TICKET_LOG_CHANNEL, logEmbed);
                
                return interaction.reply({ embeds: [holdEmbed] });
            }
            else if (action === 'delete') {
                if (!interaction.member.roles.cache.has(TICKET_STAFF_ROLE_ID) && !interaction.member.permissions.has('ModerateMembers')) {
                    return interaction.reply({ content: 'You do not have permission.', ephemeral: true });
                }
                const confirmRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('ticket_deleteconfirm').setLabel('Confirm Delete').setStyle(ButtonStyle.Danger)
                );
                return interaction.reply({ content: 'Are you sure you want to delete this ticket? Click confirm to delete in 10 seconds.', components: [confirmRow], ephemeral: true });
            }
            else if (action === 'deleteconfirm') {
                if (!interaction.member.roles.cache.has(TICKET_STAFF_ROLE_ID) && !interaction.member.permissions.has('ModerateMembers')) {
                    return interaction.reply({ content: 'You do not have permission.', ephemeral: true });
                }
                const deleteEmbed = new EmbedBuilder()
                    .setTitle('Ticket Deletion 🗑️')
                    .setDescription('Ticket will be deleted in 10 seconds...')
                    .setColor('#e74c3c');
                await interaction.reply({ embeds: [deleteEmbed] });
                
                const logEmbed = new EmbedBuilder()
                    .setTitle('Ticket Deleted')
                    .addFields(
                        { name: 'Ticket Name', value: interaction.channel.name, inline: true },
                        { name: 'Deleted By', value: `<@${interaction.user.id}>`, inline: true },
                        { name: 'Method', value: 'Standard Delete', inline: true }
                    )
                    .setTimestamp()
                    .setColor('#c0392b');
                sendLog(TICKET_LOG_CHANNEL, logEmbed);
                
                setTimeout(() => {
                    const vcName = `${interaction.channel.name}-vc`;
                    const vc = interaction.guild.channels.cache.find(c => c.name === vcName && c.type === ChannelType.GuildVoice);
                    if (vc) vc.delete().catch(console.error);
                    
                    interaction.channel.delete().catch(console.error);
                }, 10000);
            }
            else if (action === 'silentdelete') {
                if (!interaction.member.roles.cache.has(TICKET_STAFF_ROLE_ID) && !interaction.member.permissions.has('ModerateMembers')) {
                    return interaction.reply({ content: 'You do not have permission.', ephemeral: true });
                }
                const vcName = `${interaction.channel.name}-vc`;
                const vc = interaction.guild.channels.cache.find(c => c.name === vcName && c.type === ChannelType.GuildVoice);
                if (vc) vc.delete().catch(console.error);
                
                const logEmbed = new EmbedBuilder()
                    .setTitle('Ticket Deleted')
                    .addFields(
                        { name: 'Ticket Name', value: interaction.channel.name, inline: true },
                        { name: 'Deleted By', value: `<@${interaction.user.id}>`, inline: true },
                        { name: 'Method', value: 'Silent Delete', inline: true }
                    )
                    .setTimestamp()
                    .setColor('#c0392b');
                sendLog(TICKET_LOG_CHANNEL, logEmbed);
                
                interaction.channel.delete().catch(console.error);
            }
            else if (action === 'vc') {
                if (!interaction.member.roles.cache.has(TICKET_STAFF_ROLE_ID) && !interaction.member.permissions.has('ModerateMembers')) {
                    return interaction.reply({ content: 'You do not have permission.', ephemeral: true });
                }
                
                await interaction.deferReply({ ephemeral: true });
                try {
                    const overwrites = interaction.channel.permissionOverwrites.cache;
                    const voiceOverwrites = [
                        {
                            id: interaction.guild.roles.everyone,
                            deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect],
                        },
                        {
                            id: TICKET_STAFF_ROLE_ID,
                            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak],
                        }
                    ];
                    for (const [id, overwrite] of overwrites) {
                        if (overwrite.type === 1) { // Member
                            voiceOverwrites.push({
                                id: id,
                                allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak],
                            });
                        }
                    }

                    const vc = await interaction.guild.channels.create({
                        name: `${interaction.channel.name}-vc`,
                        type: ChannelType.GuildVoice,
                        parent: TICKET_CATEGORY_ID,
                        permissionOverwrites: voiceOverwrites
                    });
                    
                    const vcEmbed = new EmbedBuilder()
                        .setTitle('Voice Channel Created 🎤')
                        .setDescription(`A private voice channel has been created for this ticket: <#${vc.id}>`)
                        .setColor('#9b59b6');
                    await interaction.channel.send({ embeds: [vcEmbed] });
                    
                    const logEmbed = new EmbedBuilder()
                        .setTitle('Voice Channel Created')
                        .addFields(
                            { name: 'Ticket', value: `<#${interaction.channel.id}>`, inline: true },
                            { name: 'Voice Channel', value: `<#${vc.id}>`, inline: true },
                            { name: 'Created By', value: `<@${interaction.user.id}>`, inline: true }
                        )
                        .setTimestamp()
                        .setColor('#8e44ad');
                    sendLog(TICKET_LOG_CHANNEL, logEmbed);
                    
                    return interaction.editReply('Voice channel created.');
                } catch (err) {
                    console.error('Error creating VC:', err);
                    return interaction.editReply('Failed to create voice channel.');
                }
            }
        }

        if (parts[0] === 'dmreply') {
            const targetId = parts[1];
            const modal = new ModalBuilder()
                .setCustomId(`modaldmreply_${targetId}`)
                .setTitle(`Reply to User`);

            const replyInput = new TextInputBuilder()
                .setCustomId('replytext')
                .setLabel("Your reply:")
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true);

            modal.addComponents(new ActionRowBuilder().addComponents(replyInput));
            return interaction.showModal(modal);
        }

        if (parts[0] === 'mng') {
            const action = parts[1];
            const targetId = parts[2];
            
            const isFullAdmin = interaction.member.permissions.has('ModerateMembers');
            const hasLimitedRole = LIMITED_STAFF_ROLES.some(role => interaction.member.roles.cache.has(role));
            const canBanAndDM = hasLimitedRole || interaction.member.id === interaction.guild?.ownerId;
            
            // Recheck permissions
            if (!isFullAdmin && !hasLimitedRole) {
                return interaction.reply({ content: 'You do not have permission to use these buttons.', ephemeral: true });
            }

            if (action === 'punish') {
                const targetUser = await client.users.fetch(targetId);
                const embed = new EmbedBuilder()
                    .setTitle(`Moderation Menu for ${targetUser.tag}`)
                    .setDescription('Select an action to perform on this user.')
                    .setColor('#ff0000');

                const row = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder().setCustomId(`mod_warn_${targetId}`).setLabel('Warn').setStyle(ButtonStyle.Primary),
                        new ButtonBuilder().setCustomId(`mod_timeout_${targetId}`).setLabel('Timeout').setStyle(ButtonStyle.Secondary),
                        new ButtonBuilder().setCustomId(`mod_kick_${targetId}`).setLabel('Kick').setStyle(ButtonStyle.Danger),
                        new ButtonBuilder().setCustomId(`mod_ban_${targetId}`).setLabel('Ban').setStyle(ButtonStyle.Danger).setDisabled(!canBanAndDM)
                    );

                return interaction.update({ embeds: [embed], components: [row] });
            } 
            else if (action === 'dm') {
                if (!canBanAndDM) {
                    return interaction.reply({ content: 'You do not have permission to send a Bot DM.', ephemeral: true });
                }
                const modal = new ModalBuilder()
                    .setCustomId(`modalmngdm_${targetId}`)
                    .setTitle(`Send DM to User`);

                const replyInput = new TextInputBuilder()
                    .setCustomId('dmtext')
                    .setLabel("Message content:")
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(true);

                modal.addComponents(new ActionRowBuilder().addComponents(replyInput));
                return interaction.showModal(modal);
            }
            else if (action === 'history') {
                const targetUser = await client.users.fetch(targetId);
                const data = loadPunishments();
                const history = data[targetId] || [];

                if (history.length === 0) {
                    return interaction.update({ content: `${targetUser.tag} has a clean record.`, embeds: [], components: [] });
                }

                const embed = new EmbedBuilder()
                    .setTitle(`Moderation History: ${targetUser.tag}`)
                    .setColor('#ffa500');

                history.forEach((record, index) => {
                    const date = new Date(record.timestamp).toLocaleDateString();
                    let desc = `**Reason:** ${record.reason}\n**Moderator:** <@${record.moderatorId}>\n**Date:** ${date}`;
                    if (record.duration) desc += `\n**Duration:** ${record.duration}`;
                    embed.addFields({ name: `${index + 1}. ${record.type}`, value: desc });
                });

                return interaction.update({ embeds: [embed], components: [], content: null });
            }
        }

        if (parts[0] !== 'mod') return;

        const action = parts[1];
        const targetId = parts[2];

        const isFullAdmin = interaction.member.permissions.has('ModerateMembers');
        const hasLimitedRole = LIMITED_STAFF_ROLES.some(role => interaction.member.roles.cache.has(role));
        const canBanAndDM = hasLimitedRole || interaction.member.id === interaction.guild?.ownerId;

        // Ensure user has permissions to click
        if (!isFullAdmin && !hasLimitedRole) {
            return interaction.reply({ content: 'You do not have permission to use these buttons.', ephemeral: true });
        }
        
        if (action === 'ban' && !canBanAndDM) {
            return interaction.reply({ content: 'You do not have permission to ban users.', ephemeral: true });
        }

        const modal = new ModalBuilder()
            .setCustomId(`modal_${action}_${targetId}`)
            .setTitle(`Execute ${action.toUpperCase()}`);

        const reasonInput = new TextInputBuilder()
            .setCustomId('reason')
            .setLabel("Reason for punishment:")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true);

        const firstActionRow = new ActionRowBuilder().addComponents(reasonInput);
        modal.addComponents(firstActionRow);

        // Add duration field for timeout and ban
        if (action === 'timeout' || action === 'ban') {
            const durationInput = new TextInputBuilder()
                .setCustomId('duration')
                .setLabel(action === 'timeout' ? "Duration in minutes (e.g. 10)" : "Duration (e.g. 7 days or Permanent)")
                .setStyle(TextInputStyle.Short)
                .setRequired(true);
            const secondActionRow = new ActionRowBuilder().addComponents(durationInput);
            modal.addComponents(secondActionRow);
        }

        await interaction.showModal(modal);
    }

    // 4. Modals
    else if (interaction.isModalSubmit()) {
        const parts = interaction.customId.split('_');

        if (interaction.customId === 'modal_giveaway_setup') {
            const prize = interaction.fields.getTextInputValue('prize');
            const durationStr = interaction.fields.getTextInputValue('duration');
            const winnersCountStr = interaction.fields.getTextInputValue('winners');
            const description = interaction.fields.getTextInputValue('description');
            
            const winnersCount = parseInt(winnersCountStr) || 1;
            
            const durationMs = parseDuration(durationStr);
            if (!durationMs) {
                return interaction.reply({ content: 'Invalid duration format. Use e.g., "10m", "1h", "2d".', ephemeral: true });
            }
            
            const endTime = Date.now() + durationMs;
            const endTimestamp = Math.floor(endTime / 1000);
            
            const serverIcon = interaction.guild.iconURL({ dynamic: true, size: 512 });
            
            const gwEmbed = new EmbedBuilder()
                .setTitle(`🎉 **${prize}** 🎉`)
                .setDescription(`\n${description}\n\n🏆 **Winners:** ${winnersCount}\n⏳ **Ends:** <t:${endTimestamp}:R> (<t:${endTimestamp}:f>)\n👑 **Hosted by:** <@${interaction.user.id}>\n\n*Click the green button below to enter!*`)
                .setColor('#FFD700')
                .setTimestamp(endTime)
                .setFooter({ text: 'Giveaway Ends' });
                
            if (serverIcon) gwEmbed.setThumbnail(serverIcon);
                
            const gwRow = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder().setCustomId('gw_join').setLabel('Join Giveaway 🎉').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId('gw_participants').setLabel('Participants: 0').setStyle(ButtonStyle.Secondary).setDisabled(true)
                );
                
            const message = await interaction.reply({ embeds: [gwEmbed], components: [gwRow], fetchReply: true });
            
            const giveaways = loadGiveaways();
            giveaways[message.id] = {
                channelId: interaction.channel.id,
                prize: prize,
                description: description,
                winnersCount: winnersCount,
                endTime: endTime,
                participants: []
            };
            saveGiveaways(giveaways);
            
            scheduleGiveaway(message.id, endTime);
            return;
        }

        if (parts[0] === 'modalticket') {
            await interaction.deferReply({ ephemeral: true });
            
            if (interaction.message) {
                const resetRow = new ActionRowBuilder().addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId('ticket_menu')
                        .setPlaceholder('Select a ticket category')
                        .addOptions(
                            new StringSelectMenuOptionBuilder().setLabel('General Ticket').setDescription('Open a general support ticket').setValue('ticket_general').setEmoji('📩'),
                            new StringSelectMenuOptionBuilder().setLabel('Partner Ticket').setDescription('Apply for partnership (40+ members req)').setValue('ticket_partner').setEmoji('🤝'),
                            new StringSelectMenuOptionBuilder().setLabel('Media Application').setDescription('Apply for media (250+ subs req)').setValue('ticket_media').setEmoji('📺'),
                            new StringSelectMenuOptionBuilder().setLabel('Giveaway Claim').setDescription('Claim a giveaway prize').setValue('ticket_giveaway').setEmoji('🎉')
                        )
                );
                interaction.message.edit({ components: [resetRow] }).catch(console.error);
            }
            
            const ticketType = parts[1];
            let detailsEmbed = new EmbedBuilder().setColor('#2F3136');
            let contentMsg = `<@${interaction.user.id}> Welcome, support will be with you shortly.\n**Staff has been notified, Please Wait**`;

            if (ticketType === 'general') {
                const reason = interaction.fields.getTextInputValue('reason').substring(0, 1000);
                detailsEmbed.setTitle('General Ticket')
                            .addFields({ name: 'Why are you creating this ticket?', value: `\`\`\`\n${reason}\n\`\`\`` });
            } else if (ticketType === 'partner') {
                const members = interaction.fields.getTextInputValue('members').substring(0, 1000);
                const ad = interaction.fields.getTextInputValue('ad');
                detailsEmbed.setTitle('Partner Application')
                            .setDescription(`**Paste your ad:**\n\`\`\`\n${ad}\n\`\`\``)
                            .addFields(
                                { name: 'Do you meet the 40+ members req?', value: `\`\`\`\n${members}\n\`\`\`` }
                            );
            } else if (ticketType === 'media') {
                const subs = interaction.fields.getTextInputValue('subs').substring(0, 1000);
                const link = interaction.fields.getTextInputValue('link').substring(0, 1000);
                detailsEmbed.setTitle('Media Application')
                            .addFields(
                                { name: 'Do you meet the 250+ subs req?', value: `\`\`\`\n${subs}\n\`\`\`` },
                                { name: 'Paste your YT channel link', value: `\`\`\`\n${link}\n\`\`\`` }
                            );
            }

            let ticketNameDisplay = 'General Support';
            if (ticketType === 'partner') ticketNameDisplay = 'Partner Application';
            else if (ticketType === 'media') ticketNameDisplay = 'Media Application';
            
            const mainEmbed = new EmbedBuilder()
                .setTitle(`${interaction.user.username} - ${ticketNameDisplay} Ticket Panel`)
                .setDescription(`👋 Welcome! This is your ${ticketNameDisplay} ticket.\n✏️ Please describe your inquiry in as much detail as possible.\n🚫 Misuse of the ticket system may result in punishments.`)
                .setColor('#2ecc71');

            const buttonRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('ticket_close').setLabel('Close Ticket').setEmoji('⛔').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId('ticket_claim').setLabel('Claim Ticket').setEmoji('🙋‍♂️').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId('ticket_delete').setLabel('Delete Ticket').setEmoji('🗑️').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('ticket_staffpanel').setLabel('Staff Panel').setEmoji('🔨').setStyle(ButtonStyle.Secondary)
            );

            try {
                const channel = await interaction.guild.channels.create({
                    name: `${ticketType}-${getNextTicketNumber(ticketType)}`,
                    type: ChannelType.GuildText,
                    parent: TICKET_CATEGORY_ID,
                    permissionOverwrites: [
                        {
                            id: interaction.guild.roles.everyone,
                            deny: [PermissionFlagsBits.ViewChannel],
                        },
                        {
                            id: interaction.user.id,
                            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
                        },
                        {
                            id: TICKET_STAFF_ROLE_ID,
                            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
                        }
                    ]
                });

                await channel.send({
                    content: contentMsg,
                    embeds: [mainEmbed, detailsEmbed],
                    components: [buttonRow]
                });

                const logEmbed = new EmbedBuilder()
                    .setTitle('Ticket Created')
                    .addFields(
                        { name: 'Ticket', value: `<#${channel.id}>`, inline: true },
                        { name: 'User', value: `<@${interaction.user.id}>`, inline: true },
                        { name: 'Type', value: ticketNameDisplay, inline: true }
                    )
                    .setTimestamp()
                    .setColor('#2ecc71');
                sendLog(TICKET_LOG_CHANNEL, logEmbed);

                const successEmbed = new EmbedBuilder()
                    .setTitle('Ticket Created! 🎉')
                    .setDescription(`Your ticket has been successfully created. Click here to view it: <#${channel.id}>`)
                    .setColor('#2ecc71');
                return interaction.editReply({ content: '', embeds: [successEmbed] });
            } catch (error) {
                console.error('Error creating ticket:', error);
                return interaction.editReply({ content: 'There was an error creating your ticket.' });
            }
        }

        if (parts[0] === 'modaldmreply') {
            const targetId = parts[1];
            const replyText = interaction.fields.getTextInputValue('replytext');

            await interaction.deferReply({ ephemeral: true });

            try {
                const targetUser = await client.users.fetch(targetId);
                await targetUser.send(`**Reply from Staff:**\n${replyText}`);
                return interaction.editReply(`Successfully sent reply to <@${targetId}>.`);
            } catch (err) {
                console.error("DM Reply error:", err);
                return interaction.editReply(`Failed to send DM to that user. They might have DMs disabled.`);
            }
        }

        if (parts[0] === 'modalmngdm') {
            const targetId = parts[1];
            const dmText = interaction.fields.getTextInputValue('dmtext');

            await interaction.deferReply({ ephemeral: true });

            try {
                const targetUser = await client.users.fetch(targetId);
                await targetUser.send(`**Message from Staff:**\n${dmText}`);
                return interaction.editReply(`Successfully sent DM to <@${targetId}>.`);
            } catch (err) {
                console.error("Manage DM error:", err);
                return interaction.editReply(`Failed to send DM to that user. They might have DMs disabled.`);
            }
        }

        if (parts[0] !== 'modal') return;

        const action = parts[1];
        const targetId = parts[2];
        const reason = interaction.fields.getTextInputValue('reason');
        
        let duration = null;
        if (action === 'timeout' || action === 'ban') {
            duration = interaction.fields.getTextInputValue('duration');
        }

        await interaction.deferReply({ ephemeral: true }); // Processing might take a second

        try {
            const targetUser = await client.users.fetch(targetId);
            const targetMember = await interaction.guild.members.fetch(targetId).catch(() => null);

            // 1. Try to DM the user
            try {
                let dmMsg = `You have received a **${action.toUpperCase()}** in ${interaction.guild.name}.\n**Reason:** ${reason}`;
                if (duration) dmMsg += `\n**Duration:** ${duration}`;
                await targetUser.send(dmMsg);
            } catch (dmErr) {
                console.log("Could not DM user", targetId);
            }

            // 2. Execute Discord action
            if (action === 'timeout') {
                if (!targetMember) throw new Error("User not in server.");
                const minutes = parseInt(duration);
                if (isNaN(minutes)) throw new Error("Invalid timeout duration format. Must be a number in minutes.");
                await targetMember.timeout(minutes * 60 * 1000, reason);
            } 
            else if (action === 'kick') {
                if (!targetMember) throw new Error("User not in server.");
                await targetMember.kick(reason);
            }
            else if (action === 'ban') {
                await interaction.guild.members.ban(targetId, { reason: reason });
            }
            
            // Warn doesn't require a Discord action API, just DMing.

            // 3. Save to History
            savePunishment(targetId, action.toUpperCase(), reason, interaction.user.id, duration);

            // 4. Update the interaction
            await interaction.editReply(`Successfully executed **${action.toUpperCase()}** on <@${targetId}> for: ${reason}`);

            // Optional: edit the original message that had the buttons so they can't be clicked again
            if (interaction.message) {
                try {
                    await interaction.message.edit({ components: [] });
                } catch (e) {
                    // Ignore errors if the message was ephemeral and cannot be edited
                }
            }

        } catch (err) {
            console.error("Action error:", err);
            await interaction.editReply(`An error occurred while trying to execute that action: ${err.message}`);
        }
    }
});

// --- WELCOME EVENT ---
client.on('guildMemberAdd', async member => {
    if (WELCOME_CHANNEL_ID === 'PLACEHOLDER') return;
    
    try {
        const channel = await member.guild.channels.fetch(WELCOME_CHANNEL_ID).catch(() => null);
        if (!channel || !channel.isTextBased()) return;
        
        const welcomeEmbed = new EmbedBuilder()
            .setTitle(`Welcome to Bunji's Server! 🎉`)
            .setDescription(`Welcome <@${member.user.id}>, we're glad to have you here! Make sure to read the rules and enjoy your stay.`)
            .setImage(member.user.displayAvatarURL({ size: 512, extension: 'png' }))
            .setColor('#ff9900')
            .setTimestamp();
            
        await channel.send({ content: `Welcome <@${member.user.id}> to Bunji's Server!`, embeds: [welcomeEmbed] });
    } catch (e) {
        console.error('Error sending welcome message:', e);
    }
});

// --- KEEP-ALIVE SERVER (Render + UptimeRobot) ---
const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('Bunji Bot is alive and well!');
});

app.listen(port, () => {
    console.log(`Keep-alive web server is listening on port ${port}`);
});

// Start the bot
client.login(process.env.DISCORD_TOKEN);
