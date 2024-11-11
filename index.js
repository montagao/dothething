// index.js
import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import * as cron from 'node-cron';
import winston from 'winston';
import pLimit from 'p-limit';
import axiosRetry from 'axios-retry';
import debounce from 'lodash.debounce';
import fs from 'fs/promises';
import path from 'path';

// Constants for issue states
const DONE_STATE = '68880c3d-6e08-4ab7-b93b-bc63560d5296';
const IN_PROGRESS_STATE = '1683449c-bc79-4f7d-a0a9-877f4c90bd92';
const TODO_STATE = '1683449c-bc79-4f7d-a0a9-877f4c90bd92';
const BACKLOG_STATE = '5e3cde66-4fc5-4220-bb2c-7453ca5e83c3';

// Helper function to get priority emoji
const getPriorityEmoji = (priority) => {
    const emojis = {
        'urgent': '🔴',
        'high': '🟠',
        'medium': '🟡',
        'low': '🟢',
        'none': '⚪'
    };
    return emojis[priority] || '⚪';
};

// Setup Logger
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'debug',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}]: ${message}`)
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'bot.log' })
    ],
});

// Load environment variables
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const DAILY_CHAT_ID = process.env.DAILY_CHAT_ID;
const PLANE_API_TOKEN = process.env.PLANE_API_TOKEN;

// Plane.so API configuration
const PLANE_BASE_URL = process.env.PLANE_BASE_URL || 'https://todo.translate.mom/api/v1';
const WORKSPACE_SLUG = process.env.PLANE_WORKSPACE_SLUG || 'translatemom';
const PROJECT_ID = process.env.PLANE_PROJECT_ID || '302657e0-d57e-4813-a9af-7e85d6f9f19e';
const CYCLE_ID = process.env.PLANE_CYCLE_ID || '7972997d-441d-472e-b080-38808863a3d5';

const PROJECT_NAME = process.env.PROJECT_NAME || 'TranslateMom';

// Construct API URLs
const PLANE_API_URL = `${PLANE_BASE_URL}/workspaces/${WORKSPACE_SLUG}/projects/${PROJECT_ID}/cycles/${CYCLE_ID}/cycle-issues/`;

// Initialize persistent cache with a TTL of 5 minutes (300 seconds)
import PersistentCache from './cache-manager.js';
const cache = new PersistentCache({ stdTTL: 300, checkperiod: 320 }, logger);

// Combined function to refresh all caches
async function refreshAllCaches() {
    logger.info('Starting background cache refresh');
    logger.debug(`Cache refresh initiated at ${new Date().toISOString()}`);
    const limit = pLimit(10);

    try {
        const response = await axios.get(PLANE_API_URL, {
            headers: {
                'x-api-key': PLANE_API_TOKEN,
                'Content-Type': 'application/json'
            }
        });

        if (response.status === 200) {
            const issues = response.data.results;
            logger.debug(`Fetched ${issues.length} initial issues from Plane API`);

            // Fetch detailed information for each issue with limited concurrency
            const detailedIssues = await Promise.all(
                issues.map(issue => limit(async () => {
                    const detailUrl = `${PLANE_BASE_URL}/workspaces/${WORKSPACE_SLUG}/projects/${PROJECT_ID}/issues/${issue.id}`;
                    try {
                        const detailResponse = await axios.get(detailUrl, {
                            headers: {
                                'x-api-key': PLANE_API_TOKEN,
                                'Content-Type': 'application/json'
                            }
                        });
                        return detailResponse.data;
                    } catch (error) {
                        logger.error(`Error fetching issue detail for ${issue.id}: ${error.message}`);
                        return issue;
                    }
                }))
            );

            // Get today's date at midnight for comparison
            const today = new Date();
            today.setHours(0, 0, 0, 0);

            // Filter issues updated today
            const todayIssues = detailedIssues.filter(issue => {
                const updateDate = new Date(issue.updated_at);
                return updateDate >= today;
            });
            logger.debug(`Found ${todayIssues.length} issues updated today`);

            // Update status cache
            const statusData = {
                inProgress: detailedIssues.filter(issue => issue.state === IN_PROGRESS_STATE).length,
                todo: detailedIssues.filter(issue => issue.state === TODO_STATE).length,
                done: detailedIssues.filter(issue => issue.state === DONE_STATE).length,
                backlog: detailedIssues.filter(issue => issue.state === BACKLOG_STATE).length,
                total: detailedIssues.length,
                timestamp: new Date(),
                todayIssues: todayIssues.map(issue => ({
                    name: issue.name,
                    state: issue.state,
                    priority: issue.priority,
                    updated_at: issue.updated_at
                })),
                allIssues: detailedIssues
            };
            cache.set('statusData', statusData);
            logger.debug(`Status cache updated with ${statusData.total} total issues`);

            // Update sorted issues cache
            const priorityOrder = {
                'urgent': 4,
                'high': 3,
                'medium': 2,
                'low': 1,
                'none': 0
            };

            const sortedIssues = detailedIssues
                .filter(issue => issue.state === IN_PROGRESS_STATE || issue.state === TODO_STATE)
                .sort((a, b) => {
                    const priorityDiff = priorityOrder[b.priority] - priorityOrder[a.priority];
                    if (priorityDiff !== 0) return priorityDiff;
                    return new Date(b.updated_at) - new Date(a.updated_at);
                })
                .slice(0, 10);

            cache.set('sortedIssues', sortedIssues);
            logger.debug(`Sorted issues cache updated with ${sortedIssues.length} issues`);

            logger.info('Background cache refresh completed successfully');
        }
    } catch (error) {
        logger.error(`Background cache refresh failed: ${error.message}`);
        throw error;
    }
}

// Schedule combined cache refresh every 4 minutes
cron.schedule('*/4 * * * *', refreshAllCaches);

// Initial cache population
refreshAllCaches().catch(error => {
    logger.error(`Initial cache population failed: ${error.message}`);
});

// Setup Axios Retry for handling rate limits and transient errors
axiosRetry(axios, {
    retries: 3,
    retryDelay: axiosRetry.exponentialDelay,
    retryCondition: (error) => {
        return (error.response && error.response.status === 429) || axiosRetry.isNetworkOrIdempotentRequestError(error);
    }
});

// Initialize the bot
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Function to fetch and sort issues with caching and optimized API calls
async function fetchSortedIssues() {
    const cacheKey = 'sortedIssues';
    const limit = pLimit(10); // Move this here since pLimit is now properly imported
    logger.debug(`Fetching sorted issues at ${new Date().toISOString()}`);

    // Check if cached data exists
    const cachedIssues = cache.get(cacheKey);
    if (cachedIssues) {
        logger.info('Returning cached issues.');
        return cachedIssues;
    }

    try {
        // Fetch the main list of issues
        const response = await axios.get(PLANE_API_URL, {
            headers: {
                'x-api-key': PLANE_API_TOKEN,
                'Content-Type': 'application/json'
            }
        });

        if (response.status === 200) {
            const issues = response.data.results;

            // Fetch detailed information for each issue with limited concurrency
            const detailedIssues = await Promise.all(
                issues.map(issue => limit(async () => {
                    const detailUrl = `https://todo.translate.mom/api/v1/workspaces/translatemom/projects/302657e0-d57e-4813-a9af-7e85d6f9f19e/issues/${issue.id}`;
                    try {
                        const detailResponse = await axios.get(detailUrl, {
                            headers: {
                                'x-api-key': PLANE_API_TOKEN,
                                'Content-Type': 'application/json'
                            }
                        });
                        return detailResponse.data;
                    } catch (error) {
                        logger.error(`Error fetching issue detail for ${issue.id}: ${error.message}`);
                        return issue; // Return basic issue data if detail fetch fails
                    }
                }))
            );

            // Priority order mapping
            const priorityOrder = {
                'urgent': 4,
                'high': 3,
                'medium': 2,
                'low': 1,
                'none': 0
            };

            // Filter for IN_PROGRESS and TODO issues, then sort
            const sortedIssues = detailedIssues
                .filter(issue => issue.state === IN_PROGRESS_STATE || issue.state === TODO_STATE)
                .sort((a, b) => {
                    const priorityDiff = priorityOrder[b.priority] - priorityOrder[a.priority];
                    if (priorityDiff !== 0) return priorityDiff;
                    return new Date(b.updated_at) - new Date(a.updated_at);
                })
                .slice(0, 10); // Get top 10

            logger.info(`Fetched and sorted ${sortedIssues.length} active issues.`);

            // Store in cache
            cache.set(cacheKey, sortedIssues);

            return sortedIssues;
        } else {
            logger.error(`Failed to fetch issues: ${response.status}`);
            return [];
        }
    } catch (error) {
        logger.error(`Error fetching issues: ${error.message}`);
        return [];
    }
}

// Debounced fetch for user requests to prevent redundant API calls
const getIssuesDebounced = debounce(async () => {
    return await fetchSortedIssues();
}, 1000, { leading: true, trailing: true });

// Daily tasks management
async function loadDailyTasks() {
    try {
        const data = await fs.readFile('dailies.json', 'utf8');
        return JSON.parse(data);
    } catch (error) {
        logger.error(`Error loading daily tasks: ${error.message}`);
        return { tasks: [] };
    }
}

async function saveDailyTasks(tasks) {
    try {
        await fs.writeFile('dailies.json', JSON.stringify({ tasks }, null, 2));
    } catch (error) {
        logger.error(`Error saving daily tasks: ${error.message}`);
    }
}

// Reset daily tasks at midnight
cron.schedule('0 0 * * *', async () => {
    const dailyTasks = await loadDailyTasks();
    dailyTasks.tasks = dailyTasks.tasks.map(task => ({ ...task, completed: false }));
    await saveDailyTasks(dailyTasks.tasks);
    logger.info('Daily tasks reset for new day');
});

// Handler function for dailies command
const handleDailiesCommand = async (chatId) => {
    logger.info(`Handling /dailies command for chat ID: ${chatId}`);

    try {
        const dailyTasks = await loadDailyTasks();

        const keyboard = dailyTasks.tasks.map(task => ([{
            text: `${task.completed ? '✅' : '⬜'} ${task.text}`,
            callback_data: `toggle_daily_${task.id}`
        }]));

        // Add management buttons
        keyboard.push([
            { text: '➕ Add Task', callback_data: 'add_daily' },
            { text: '🗑️ Remove Task', callback_data: 'remove_daily' }
        ]);

        const message = '*📋 Daily Tasks:*\n\n' +
            dailyTasks.tasks.map(task =>
                `${task.completed ? '✅' : '⬜'} ${task.text}`
            ).join('\n');

        return {
            success: true,
            message,
            keyboard
        };
    } catch (error) {
        logger.error(`Error handling dailies command: ${error.message}`);
        return {
            success: false,
            message: '❌ An error occurred while fetching daily tasks. Please try again later.'
        };
    }
};



// Handle callback queries for daily tasks
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const data = query.data;

    if (data.startsWith('toggle_daily_')) {
        const taskId = data.replace('toggle_daily_', '');
        const dailyTasks = await loadDailyTasks();

        const taskIndex = dailyTasks.tasks.findIndex(t => t.id === taskId);
        if (taskIndex !== -1) {
            dailyTasks.tasks[taskIndex].completed = !dailyTasks.tasks[taskIndex].completed;
            await saveDailyTasks(dailyTasks.tasks);

            // Update message with new state
            const keyboard = dailyTasks.tasks.map(task => ([{
                text: `${task.completed ? '✅' : '⬜'} ${task.text}`,
                callback_data: `toggle_daily_${task.id}`
            }]));

            keyboard.push([
                { text: '➕ Add Task', callback_data: 'add_daily' },
                { text: '🗑️ Remove Task', callback_data: 'remove_daily' }
            ]);

            const message = '*📋 Daily Tasks:*\n\n' +
                dailyTasks.tasks.map(task =>
                    `${task.completed ? '✅' : '⬜'} ${task.text}`
                ).join('\n');

            await bot.editMessageText(message, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: keyboard
                }
            });
        }
    } else if (data === 'add_daily') {
        // Start add task conversation
        await bot.sendMessage(chatId, 'Please enter the new daily task:');
        // Store state that next message should be treated as new task
        cache.set(`adding_daily_${chatId}`, true, 300); // 5 minute timeout
    } else if (data === 'remove_daily') {
        const dailyTasks = await loadDailyTasks();
        const keyboard = dailyTasks.tasks.map(task => ([{
            text: `🗑️ ${task.text}`,
            callback_data: `delete_daily_${task.id}`
        }]));

        await bot.sendMessage(chatId, '*Select task to remove:*', {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: keyboard
            }
        });
    } else if (data.startsWith('delete_daily_')) {
        const taskId = data.replace('delete_daily_', '');
        const dailyTasks = await loadDailyTasks();

        dailyTasks.tasks = dailyTasks.tasks.filter(t => t.id !== taskId);
        await saveDailyTasks(dailyTasks.tasks);

        await bot.sendMessage(chatId, 'Task removed! Use /dailies to see updated list.');
    }

    // Answer callback query to remove loading state
    await bot.answerCallbackQuery(query.id);
});

// Handle new task messages
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const isAddingDaily = cache.get(`adding_daily_${chatId}`);

    if (isAddingDaily && msg.text && !msg.text.startsWith('/')) {
        const dailyTasks = await loadDailyTasks();
        const newId = (Math.max(...dailyTasks.tasks.map(t => parseInt(t.id)), 0) + 1).toString();

        dailyTasks.tasks.push({
            id: newId,
            text: msg.text,
            completed: false
        });

        await saveDailyTasks(dailyTasks.tasks);
        cache.del(`adding_daily_${chatId}`);

        await bot.sendMessage(chatId, 'Task added! Use /dailies to see updated list.');
    }
});

// Issue management functions
async function addIssue(name) {
    try {
        logger.debug(`Starting issue creation for: "${name}"`);
        logger.debug(`Making POST request to: ${PLANE_BASE_URL}/workspaces/${WORKSPACE_SLUG}/projects/${PROJECT_ID}/issues/`);

        // First create the issue with TODO state
        const createResponse = await axios.post(
            `${PLANE_BASE_URL}/workspaces/${WORKSPACE_SLUG}/projects/${PROJECT_ID}/issues/`,
            {
                name,
                state: TODO_STATE,
            },
            {
                headers: {
                    'x-api-key': PLANE_API_TOKEN,
                    'Content-Type': 'application/json'
                }
            }
        );

        logger.debug(`Create issue response status: ${createResponse.status}`);
        logger.debug(`Create issue response data: ${JSON.stringify(createResponse.data)}`);

        if (createResponse.status === 201) {
            const issueId = createResponse.data.id;
            logger.debug(`Issue created successfully with ID: ${issueId}`);
            logger.debug(`Adding issue to cycle: ${CYCLE_ID}`);

            // Then add it to the cycle
            const cycleResponse = await axios.post(
                `${PLANE_BASE_URL}/workspaces/${WORKSPACE_SLUG}/projects/${PROJECT_ID}/cycles/${CYCLE_ID}/cycle-issues/`,
                { issues: [issueId] },
                {
                    headers: {
                        'x-api-key': PLANE_API_TOKEN,
                        'Content-Type': 'application/json'
                    }
                }
            );

            logger.debug(`Cycle addition response status: ${cycleResponse.status}`);
            logger.debug(`Cycle addition response data: ${JSON.stringify(cycleResponse.data)}`);

            if (cycleResponse.status === 201) {
                logger.debug(`Issue successfully added to cycle`);
                return createResponse.data;
            }
        }
    } catch (error) {
        logger.error(`Error creating issue: ${error.message}`);
        logger.debug(`Full error details: ${JSON.stringify(error.response?.data || error)}`);
        throw error;
    }
}

async function editIssue(issueId, updates) {
    try {
        const response = await axios.patch(
            `${PLANE_BASE_URL}/workspaces/${WORKSPACE_SLUG}/projects/${PROJECT_ID}/issues/${issueId}`,
            updates,
            {
                headers: {
                    'x-api-key': PLANE_API_TOKEN,
                    'Content-Type': 'application/json'
                }
            }
        );
        return response.data;
    } catch (error) {
        logger.error(`Error editing issue: ${error.message}`);
        throw error;
    }
}

async function deleteIssue(issueId) {
    try {
        await axios.delete(
            `${PLANE_BASE_URL}/workspaces/${WORKSPACE_SLUG}/projects/${PROJECT_ID}/issues/${issueId}`,
            {
                headers: {
                    'x-api-key': PLANE_API_TOKEN
                }
            }
        );
        return true;
    } catch (error) {
        logger.error(`Error deleting issue: ${error.message}`);
        throw error;
    }
}

// Handler for the /manage_issues command
// Handler for managing issues
const handleManageCommand = async (chatId) => {
    logger.info(`Handling /manage command for chat ID: ${chatId}`);

    try {
        const keyboard = {
            inline_keyboard: [
                [{ text: '➕ Add New Issue', callback_data: 'add_issue' }],
                [{ text: '✏️ Edit Issue', callback_data: 'edit_issue_list' }],
                [{ text: '🗑️ Delete Issue', callback_data: 'delete_issue_list' }]
            ]
        };

        const managementMessage = {
            success: true,
            message: '*Issue Management*\nWhat would you like to do?',
            keyboard: keyboard
        };

        const issues = await fetchSortedIssues();

        if (issues.length > 0) {
            const issueLines = issues.map(issue => {
                const stateEmoji = issue.state === IN_PROGRESS_STATE ? '🏃' : '📋';
                const priorityEmoji = getPriorityEmoji(issue.priority);
                const updatedDate = new Date(issue.updated_at).toLocaleString();

                return `${stateEmoji} ${priorityEmoji} *${issue.name}*\n   └ Updated: ${updatedDate}`;
            });

            managementMessage.issuesMessage = `\n📋 *Current Active Issues:*\n\n${issueLines.join('\n\n')}`;
        }

        return managementMessage;
    } catch (error) {
        logger.error(`Error handling manage command: ${error.message}`);
        return {
            success: false,
            message: '❌ An error occurred while fetching issues. Please try again later.'
        };
    }
};

// Register the /manage command
bot.onText(/\/manage/, async (msg) => {
    const chatId = msg.chat.id;

    // Send initial processing message
    await bot.sendMessage(chatId, 'Loading issue management options, please wait...');

    // Handle the command
    const result = await handleManageCommand(chatId);

    // Send the management options
    await bot.sendMessage(
        chatId,
        result.message,
        {
            parse_mode: 'Markdown',
            reply_markup: result.success ? result.keyboard : undefined
        }
    );

    // Send the current issues list if available
    if (result.success && result.issuesMessage) {
        await bot.sendMessage(
            chatId,
            result.issuesMessage,
            { parse_mode: 'Markdown' }
        );
    }
});

// Add issue conversation state management
const conversationState = new Map();

// Handle callback queries for help commands and issue management
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const msg = query.message;
    try {
        // Handle command callbacks from help menu
        if (query.data.startsWith('/')) {
            let result;;
            switch (query.data) {
                case '/issues':
                    // Send initial processing message
                    await bot.sendMessage(chatId, 'Fetching latest todo & inprogress issues, please wait...');

                    // Handle the command
                    result = await handleIssuesCommand(chatId);

                    // Send the response
                    await bot.sendMessage(
                        chatId,
                        result.message,
                        result.success ? { parse_mode: 'Markdown' } : {}
                    );
                    break;
                case '/status':

                    // Send initial processing message
                    await bot.sendMessage(chatId, 'Fetching project status, please wait...');

                    // Handle the command
                    result = await handleStatusCommand(chatId);

                    // Send the response
                    try {
                        await bot.sendMessage(
                            chatId,
                            result.message,
                            result.success ? { parse_mode: 'Markdown' } : {}
                        );
                    } catch (error) {
                        if (error.code === 'ETELEGRAM' && error.response?.statusCode === 400) {
                            logger.warn(`Failed to send status message: ${error.message}`);
                            // Try sending without markdown if parsing failed
                            try {
                                await bot.sendMessage(chatId, result.message.replace(/[*_`]/g, ''));
                            } catch (retryError) {
                                logger.error(`Failed to send plain text message: ${retryError.message}`);
                            }
                        }
                    }
                    break;
                case '/dailies':
                    // Send initial processing message
                    await bot.sendMessage(chatId, 'Fetching daily tasks, please wait...');

                    // Handle the command
                    result = await handleDailiesCommand(chatId);

                    // Send the response
                    await bot.sendMessage(
                        chatId,
                        result.message,
                        {
                            parse_mode: 'Markdown',
                            reply_markup: result.success ? {
                                inline_keyboard: result.keyboard
                            } : undefined
                        }
                    );

                    break;
                case '/completed':
                    // Send initial processing message
                    await bot.sendMessage(chatId, 'Fetching completed issues, please wait...');

                    // Handle the command
                    result = await handleCompletedCommand(chatId);

                    // Send the response
                    await bot.sendMessage(
                        chatId,
                        result.message,
                        result.success ? { parse_mode: 'Markdown' } : {}
                    );
                    break;
                case '/stats':
                    // Send initial processing message
                    await bot.sendMessage(chatId, 'Calculating project statistics, please wait...');

                    // Handle the command
                    result = await handleStatsCommand(chatId);

                    // Send the response
                    await bot.sendMessage(
                        chatId,
                        result.message,
                        result.success ? { parse_mode: 'Markdown' } : {}
                    );
                    break;
                case '/manage':
                    // Send initial processing message
                    await bot.sendMessage(chatId, 'Loading issue management options, please wait...');

                    // Handle the command
                    result = await handleManageCommand(chatId);

                    // Send the management options
                    await bot.sendMessage(
                        chatId,
                        result.message,
                        {
                            parse_mode: 'Markdown',
                            reply_markup: result.success ? result.keyboard : undefined
                        }
                    );

                    // Send the current issues list if available
                    if (result.success && result.issuesMessage) {
                        await bot.sendMessage(
                            chatId,
                            result.issuesMessage,
                            { parse_mode: 'Markdown' }
                        );
                    }
                    break;
                default:
                    throw new Error('Invalid command');
            }

        }

        // Answer callback query immediately to prevent timeout
        await bot.answerCallbackQuery(query.id).catch(error => {
            logger.warn(`Failed to answer callback query: ${error.message}`);
        });

        const messageId = query.message.message_id;
        const data = query.data;

        if (data === 'add_issue') {
            conversationState.set(chatId, { state: 'awaiting_issue_name' });
            await bot.sendMessage(chatId, 'Please enter the name of the new issue:');
        }
        else if (data === 'edit_issue_list' || data === 'delete_issue_list') {
            try {
                let statusData = cache.get('statusData');
                if (!statusData) {
                    statusData = await refreshAllCaches();
                }
                const issues = statusData.allIssues;
                const keyboard = issues.map(issue => ([{
                    text: issue.name,
                    callback_data: `${data === 'edit_issue_list' ? 'edit' : 'delete'}_issue_${issue.id}`
                }]));

                await bot.editMessageText(
                    `Select an issue to ${data === 'edit_issue_list' ? 'edit' : 'delete'}:`,
                    {
                        chat_id: chatId,
                        message_id: messageId,
                        reply_markup: { inline_keyboard: keyboard }
                    }
                );
            } catch (error) {
                logger.error(`Error fetching issues: ${error.message}`);
                await bot.sendMessage(chatId, '❌ Failed to fetch issues. Please try again.');
            }
        }
        else if (data.startsWith('edit_issue_')) {
            const issueId = data.replace('edit_issue_', '');

            try {
                // Fetch current issue details
                const response = await axios.get(
                    `${PLANE_BASE_URL}/workspaces/${WORKSPACE_SLUG}/projects/${PROJECT_ID}/issues/${issueId}`,
                    {
                        headers: {
                            'x-api-key': PLANE_API_TOKEN,
                            'Content-Type': 'application/json'
                        }
                    }
                );

                const issue = response.data;
                const priorityEmoji = getPriorityEmoji(issue.priority);
                const stateEmoji = issue.state === IN_PROGRESS_STATE ? '🏃' :
                    issue.state === TODO_STATE ? '📋' :
                        issue.state === DONE_STATE ? '✅' : '📝';

                conversationState.set(chatId, {
                    state: 'awaiting_issue_edit',
                    issueId: issueId
                });
                const isDone = issue.state === DONE_STATE;
                const keyboard = {
                    inline_keyboard: [
                        [{ text: isDone ? '↩️ Mark as Todo' : '✅ Mark as Done', callback_data: `quick_toggle_${issueId}_${isDone ? 'todo' : 'done'}` }],
                        [{ text: 'Edit Name', callback_data: `edit_name_${issueId}` }],
                        [{ text: 'Edit Priority', callback_data: `edit_priority_${issueId}` }],
                        [{ text: 'Edit State', callback_data: `edit_state_${issueId}` }],
                        [{ text: '❌ Cancel', callback_data: 'cancel_edit' }]
                    ]
                };

                const currentStatus = `*Current Issue Details:*\n` +
                    `Name: ${issue.name}\n` +
                    `Priority: ${priorityEmoji} ${issue.priority || 'none'}\n` +
                    `State: ${stateEmoji}\n\n` +
                    `What would you like to edit?`;

                await bot.editMessageText(currentStatus, {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'Markdown',
                    reply_markup: keyboard
                });
            } catch (error) {
                logger.error(`Error fetching issue details: ${error.message}`);
                await bot.sendMessage(chatId, '❌ Failed to fetch issue details. Please try again.');
            }
        }
        else if (data.startsWith('edit_name_')) {
            const issueId = data.replace('edit_name_', '');
            conversationState.set(chatId, {
                state: 'awaiting_new_name',
                issueId: issueId
            });
            await bot.sendMessage(chatId, 'Please enter the new name for the issue:');
        }
        else if (data.startsWith('edit_priority_')) {
            const issueId = data.replace('edit_priority_', '');
            const keyboard = {
                inline_keyboard: [
                    [
                        { text: '🔴 Urgent', callback_data: `p_${issueId}_u` },
                        { text: '🟠 High', callback_data: `p_${issueId}_h` }
                    ],
                    [
                        { text: '🟡 Medium', callback_data: `p_${issueId}_m` },
                        { text: '🟢 Low', callback_data: `p_${issueId}_l` }
                    ],
                    [{ text: '⚪ None', callback_data: `p_${issueId}_n` }]
                ]
            };

            await bot.editMessageText('Select the new priority:', {
                chat_id: chatId,
                message_id: messageId,
                reply_markup: keyboard
            });
        }
        else if (data.startsWith('p_')) {
            const [, issueId, priorityCode] = data.split('_');
            const priorityMap = {
                'u': 'urgent',
                'h': 'high',
                'm': 'medium',
                'l': 'low',
                'n': 'none'
            };
            const priority = priorityMap[priorityCode];
            try {
                const updatedIssue = await editIssue(issueId, { priority });
                await bot.sendMessage(chatId, `✅ Priority updated for "*${updatedIssue.name}*" to *${priority}*`, { parse_mode: 'Markdown' });
                await refreshAllCaches();
            } catch (error) {
                await bot.sendMessage(chatId, '❌ Failed to update priority.');
            }
        }
        else if (data.startsWith('edit_state_')) {
            const issueId = data.replace('edit_state_', '');
            const keyboard = {
                inline_keyboard: [
                    [{ text: '🏃 In Progress', callback_data: `set_state_${issueId}_inprogress` }],
                    [{ text: '📋 Todo', callback_data: `set_state_${issueId}_todo` }],
                    [{ text: '✅ Done', callback_data: `set_state_${issueId}_done` }],
                    [{ text: '📝 Backlog', callback_data: `set_state_${issueId}_backlog` }]
                ]
            };

            await bot.editMessageText('Select the new state:', {
                chat_id: chatId,
                message_id: messageId,
                reply_markup: keyboard
            });
        }
        else if (data.startsWith('set_state_')) {
            const [, , issueId, state] = data.split('_');
            try {
                let updatedIssue;
                switch (state) {
                    case 'inprogress':
                        updatedIssue = await editIssue(issueId, { state: IN_PROGRESS_STATE });
                        await bot.sendMessage(chatId, `🏃 Moved "*${updatedIssue.name}*" to *IN PROGRESS*`, { parse_mode: 'Markdown' });
                        break;
                    case 'todo':
                        updatedIssue = await editIssue(issueId, { state: TODO_STATE });
                        await bot.sendMessage(chatId, `📋 Moved "*${updatedIssue.name}*" to *TODO*`, { parse_mode: 'Markdown' });
                        break;
                    case 'done':
                        updatedIssue = await editIssue(issueId, { state: DONE_STATE });
                        await bot.sendMessage(chatId, `✅ Marked "*${updatedIssue.name}*" as *DONE*`, { parse_mode: 'Markdown' });
                        break;
                    case 'backlog':
                        updatedIssue = await editIssue(issueId, { state: BACKLOG_STATE });
                        await bot.sendMessage(chatId, `📝 Moved "*${updatedIssue.name}*" to *BACKLOG*`, { parse_mode: 'Markdown' });
                        break;
                    default:
                        throw new Error('Invalid state');
                }
                await refreshAllCaches();
            } catch (error) {
                await bot.sendMessage(chatId, '❌ Failed to update state.');
            }
        }
        else if (data.startsWith('delete_issue_')) {
            const issueId = data.replace('delete_issue_', '');
            try {
                // Get issue details before deletion
                const response = await axios.get(
                    `${PLANE_BASE_URL}/workspaces/${WORKSPACE_SLUG}/projects/${PROJECT_ID}/issues/${issueId}`,
                    {
                        headers: {
                            'x-api-key': PLANE_API_TOKEN,
                            'Content-Type': 'application/json'
                        }
                    }
                );
                const issueName = response.data.name;
                await deleteIssue(issueId);
                await bot.sendMessage(chatId, `✅ Deleted issue: "*${issueName}*"`, { parse_mode: 'Markdown' });
                await refreshAllCaches();
            } catch (error) {
                await bot.sendMessage(chatId, '❌ Failed to delete issue.');
            }
        }
        else if (data.startsWith('quick_toggle_')) {
            const [, issueId, newState] = data.split('_');
            try {
                const state = newState === 'done' ? DONE_STATE : TODO_STATE;
                let updatedIssue;
                switch (newState) {
                    case 'done':
                        updatedIssue = await editIssue(issueId, { state: DONE_STATE });
                        await bot.sendMessage(chatId, `✅ Completed issue: "*${updatedIssue.name}*"`, { parse_mode: 'Markdown' });
                        break;
                    case 'todo':
                        updatedIssue = await editIssue(issueId, { state: TODO_STATE });
                        await bot.sendMessage(chatId, `↩️ Moved issue back to TODO: "*${updatedIssue.name}*"`, { parse_mode: 'Markdown' });
                        break;
                    default:
                        throw new Error('Invalid state');
                }
                await refreshAllCaches();
            } catch (error) {
                await bot.sendMessage(chatId, '❌ Failed to update issue state.');
            }
        }
        else if (data === 'cancel_edit') {
            conversationState.delete(chatId);
            await bot.editMessageText('✖️ Edit cancelled', {
                chat_id: chatId,
                message_id: messageId
            });
        }


    } catch (error) {
        logger.error(`Error handling callback query: ${error.message}`);
        try {
            await bot.sendMessage(chatId, '❌ An error occurred while processing your request. Please try again.');
        } catch (sendError) {
            logger.error(`Failed to send error message: ${sendError.message}`);
        }
    }
});

// Handle text messages for issue management
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const state = conversationState.get(chatId);

    if (!state || msg.text?.startsWith('/')) return;

    try {
        if (state.state === 'awaiting_issue_name') {
            const newIssue = await addIssue(msg.text);
            await bot.sendMessage(chatId, `✅ Issue "${msg.text}" created successfully!`);
        }
        else if (state.state === 'awaiting_new_name') {
            await editIssue(state.issueId, { name: msg.text });
            await bot.sendMessage(chatId, '✅ Issue name updated successfully!');
        }
    } catch (error) {
        logger.error(`Error handling message: ${error.message}`);
        await bot.sendMessage(chatId, '❌ An error occurred. Please try again.');
    }

    await refreshAllCaches();
    // Clear conversation state
    conversationState.delete(chatId);
});

// Handler for the /help command
bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    logger.info(`Received /help command from chat ID: ${chatId}`);

    const helpMessage = `🤖 *Command Reference*\n\nClick any command below to use it:`;

    // Create inline keyboard with command buttons
    const keyboard = {
        inline_keyboard: [
            // Daily Tasks section
            [{ text: "📋 /dailies - Manage daily tasks", callback_data: "/dailies" }],

            // Task Management section
            [{ text: "📋 /issues - Show active tasks", callback_data: "/issues" }],
            [{ text: "✅ /completed - Show completed ", callback_data: "/completed" }],
            [{ text: "📊 /status - Show project status", callback_data: "/status" }],

            // Statistics & Management section
            [{ text: "📈 /stats - Show statistics", callback_data: "/stats" }],
            [{ text: "🛠️ /manage - Manage issues", callback_data: "/manage" }],
        ]
    };

    const legendMessage = `
*Priority Levels:*
🔴 \\- Urgent
🟠 \\- High
🟡 \\- Medium
🟢 \\- Low
⚪ \\- None

*Status Types:*
🏃 \\- In Progress
📋 \\- Todo
✅ \\- Completed`;

    try {
        // Send interactive command menu
        await bot.sendMessage(chatId, helpMessage, {
            parse_mode: 'MarkdownV2',
            reply_markup: keyboard,
            disable_web_page_preview: true
        });

        // Send legend as a separate message
        await bot.sendMessage(chatId, legendMessage, {
            parse_mode: 'MarkdownV2',
            disable_web_page_preview: true
        });
    } catch (error) {
        if (error.code === 'ETELEGRAM' && error.response?.statusCode === 400) {
            logger.warn(`Failed to send help message: ${error.message}`);
            // Try sending without markdown formatting
            try {
                await bot.sendMessage(chatId, helpMessage.replace(/[*_`\\]/g, ''), {
                    disable_web_page_preview: true
                });
            } catch (retryError) {
                logger.error(`Failed to send plain help message: ${retryError.message}`);
            }
        } else {
            logger.error(`Unexpected error: ${error.message}`);
            throw error;
        }
    }
});

// Handler for the /status command
const handleStatusCommand = async (chatId) => {
    logger.info(`Handling /status command for chat ID: ${chatId}`);

    try {
        const cacheKey = 'statusData';
        let statusData = cache.get(cacheKey);

        if (!statusData) {
            statusData = await refreshAllCaches();
        }

        // Helper function to get state emoji
        const getStateEmoji = (state) => {
            switch (state) {
                case IN_PROGRESS_STATE: return '🏃';
                case TODO_STATE: return '📋';
                case DONE_STATE: return '✅';
                case BACKLOG_STATE: return '📝';
                default: return '❓';
            }
        };

        // Format today's issues
        const todayIssuesFormatted = (statusData.todayIssues || [])
            .map(issue => {
                const stateEmoji = getStateEmoji(issue.state);
                const priorityEmoji = getPriorityEmoji(issue.priority);
                const updateTime = new Date(issue.updated_at).toLocaleTimeString();
                return `${stateEmoji} ${priorityEmoji} ${issue.name}\n   └ Updated at: ${updateTime}`;
            })
            .join('\n');

        // Get daily tasks
        const dailyTasks = await loadDailyTasks();
        const dailiesFormatted = dailyTasks.tasks
            .map(task => `${task.completed ? '✅' : '⬜'} ${task.text}`)
            .join('\n');

        const message = `
📊 *${PROJECT_NAME} Cycle Overview*

🏃 In Progress: ${statusData.inProgress} tasks
📋 Todo: ${statusData.todo} tasks
✅ Completed: ${statusData.done} tasks
📝 Backlog: ${statusData.backlog} tasks
━━━━━━━━━━━━━━━━
📈 Total: ${statusData.total} tasks

📋 *Daily Tasks:*
${dailiesFormatted || "No daily tasks set"}

📅 *Updated Today (${statusData.todayIssues.length} issues):*
${todayIssuesFormatted || "No issues updated today"}

🕒 Last updated: ${new Date(statusData.timestamp).toLocaleString()}
`;

        return { success: true, message };
    } catch (error) {
        logger.error(`Error fetching status: ${error.message}`);
        return {
            success: false,
            message: '❌ An error occurred while fetching project status.'
        };
    }
};

// Register the /status command
bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    const username = msg.from.username || msg.from.first_name;
    logger.info(`Received /status command from user ${username} (chat ID: ${chatId})`);
    logger.debug(`Full message details: ${JSON.stringify(msg)}`);

    // Send initial processing message
    await bot.sendMessage(chatId, 'Fetching project status, please wait...');

    // Handle the command
    const result = await handleStatusCommand(chatId);

    // Send the response
    try {
        await bot.sendMessage(
            chatId,
            result.message,
            result.success ? { parse_mode: 'Markdown' } : {}
        );
    } catch (error) {
        if (error.code === 'ETELEGRAM' && error.response?.statusCode === 400) {
            logger.warn(`Failed to send status message: ${error.message}`);
            // Try sending without markdown if parsing failed
            try {
                await bot.sendMessage(chatId, result.message.replace(/[*_`]/g, ''));
            } catch (retryError) {
                logger.error(`Failed to send plain text message: ${retryError.message}`);
            }
        }
    }
});

// Register the /dailies command
bot.onText(/\/dailies/, async (msg) => {
    const chatId = msg.chat.id;

    // Send initial processing message
    await bot.sendMessage(chatId, 'Fetching daily tasks, please wait...');

    // Handle the command
    const result = await handleDailiesCommand(chatId);

    // Send the response
    await bot.sendMessage(
        chatId,
        result.message,
        {
            parse_mode: 'Markdown',
            reply_markup: result.success ? {
                inline_keyboard: result.keyboard
            } : undefined
        }
    );
});

// Handler for the /stats command
const handleStatsCommand = async (chatId) => {
    logger.info(`Handling /stats command for chat ID: ${chatId}`);

    try {
        // Get cached status data or refresh if needed
        let statusData = cache.get('statusData');
        if (!statusData) {
            await refreshAllCaches();
            statusData = cache.get('statusData');
        }

        // Get cached detailed issues
        let sortedIssues = cache.get('sortedIssues');
        if (!sortedIssues) {
            await refreshAllCaches();
            sortedIssues = cache.get('sortedIssues');
        }

        const issues = statusData.allIssues;

        // Calculate priority distribution from today's issues
        const priorities = {
            urgent: issues.filter(i => i.priority === 'urgent').length,
            high: issues.filter(i => i.priority === 'high').length,
            medium: issues.filter(i => i.priority === 'medium').length,
            low: issues.filter(i => i.priority === 'low').length,
            none: issues.filter(i => i.priority === 'none').length
        };

        // Use statusData for completion rate
        const completedTasks = statusData.done;
        const totalTasks = statusData.total;
        const completionRate = ((completedTasks / totalTasks) * 100).toFixed(1);

        // Calculate tasks with/without due dates from today's issues
        const withDueDate = issues.filter(i => i.target_date).length;
        const withoutDueDate = issues.filter(i => !i.target_date).length;

        // Get recently updated tasks from statusData
        const inProgressTasks = issues
            .filter(i => i.state === IN_PROGRESS_STATE)
            .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))
            .slice(0, 5);

        const todoTasks = issues
            .filter(i => i.state === TODO_STATE)
            .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))
            .slice(0, 5);

        const doneTasks = issues
            .filter(i => i.state === DONE_STATE)
            .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))
            .slice(0, 5);

        // Format task lists
        const formatTasks = (tasks) => {
            return tasks.map(task => {
                // Get state emoji
                const stateEmoji = task.state === IN_PROGRESS_STATE ? '🏃' : '📋';

                // Get priority emoji
                const priorityEmojis = {
                    'urgent': '🔴',
                    'high': '🟠',
                    'medium': '🟡',
                    'low': '🟢',
                    'none': '⚪'
                };
                const priorityEmoji = priorityEmojis[task.priority] || '⚪';
                const priority = task.priority.toUpperCase() || 'NONE';

                // Format dates
                const updatedDate = new Date(task.updated_at).toLocaleString();
                const targetDate = task.target_date ? new Date(task.target_date).toLocaleDateString() : 'No due date';

                // Build message lines
                let lines = [];
                lines.push(`  ${stateEmoji} *${task.name}*`);
                lines.push(`    └ Updated: 🕒 ${updatedDate}`);

                return lines.join('\n');
            }).join('\n\n');
        };

        const message = `
📊 *${PROJECT_NAME} Dev Cycle Statistics*

*Priority Distribution:*
🔴 Urgent: ${priorities.urgent}
🟠 High: ${priorities.high}
🟡 Medium: ${priorities.medium}
🟢 Low: ${priorities.low}
⚪ None: ${priorities.none}

*Progress Metrics:*
✅ Completion Rate: ${completionRate}%
📅 Tasks with due date: ${withDueDate}
❓ Tasks without due date: ${withoutDueDate}

*Active Tasks by State:*
🏃 In Progress: ${statusData.inProgress}
📋 Todo: ${statusData.todo}

*🏃Recent In Progress Tasks:*
${formatTasks(inProgressTasks)}

*📋Recent Todo Tasks:*
${formatTasks(todoTasks)}

*✅Recent Completed Tasks:*
${formatTasks(doneTasks)}
`;

        return { success: true, message };
    } catch (error) {
        logger.error(`Error fetching statistics: ${error.message}`);
        return {
            success: false,
            message: '❌ An error occurred while calculating project statistics.'
        };
    }
};

// Register the /stats command
bot.onText(/\/stats/, async (msg) => {
    const chatId = msg.chat.id;
    const username = msg.from.username || msg.from.first_name;
    logger.info(`Received /stats command from user ${username} (chat ID: ${chatId})`);
    logger.debug(`Processing stats request at ${new Date().toISOString()}`);

    // Send initial processing message
    await bot.sendMessage(chatId, 'Calculating project statistics, please wait...');

    // Handle the command
    const result = await handleStatsCommand(chatId);

    // Send the response
    await bot.sendMessage(
        chatId,
        result.message,
        result.success ? { parse_mode: 'Markdown' } : {}
    );
});

// Format a single issue for display
const formatIssue = (issue) => {
    const stateEmoji = issue.state === IN_PROGRESS_STATE ? '🏃' : '📋';
    const priorityEmojis = {
        'urgent': '🔴',
        'high': '🟠',
        'medium': '🟡',
        'low': '🟢',
        'none': '⚪'
    };
    const priorityEmoji = priorityEmojis[issue.priority] || '⚪';
    const priority = issue.priority.toUpperCase() || 'NONE';

    const updatedDate = new Date(issue.updated_at).toLocaleString();
    const targetDate = issue.target_date ? new Date(issue.target_date).toLocaleDateString() : 'No due date';

    const lines = [];
    lines.push(`${stateEmoji} *${issue.name}*`);
    lines.push(`├ Priority: ${priorityEmoji} ${priority}`);
    lines.push(`├ Due: 📅 ${targetDate}`);
    lines.push(`├ Updated: 🕒 ${updatedDate}`);

    if (issue.description_html) {
        const plainDescription = issue.description_html.replace(/<[^>]*>/g, '').trim();
        if (plainDescription) {
            lines.push(`├ Description: 📝 ${plainDescription}`);
        }
    }

    if (issue.assignees && issue.assignees.length > 0) {
        lines.push(`└ Assignees: 👤 ${issue.assignees.join(', ')}`);
    } else {
        lines.push(`└ Assignees: 👤 Unassigned`);
    }

    return lines.join('\n');
};

// Handler for displaying active issues
const handleIssuesCommand = async (chatId) => {
    logger.info(`Handling /issues command for chat ID: ${chatId}`);

    try {
        const issues = await getIssuesDebounced();

        if (issues.length > 0) {
            const issueLines = issues.map(formatIssue);
            const message = `🎯 *Top 10 Active Issues:*\n\n${issueLines.join('\n\n')}`;
            return { success: true, message };
        } else {
            return {
                success: true,
                message: '⚠️ No active issues found in IN_PROGRESS or TODO state.'
            };
        }
    } catch (error) {
        logger.error(`Error fetching issues: ${error.message}`);
        return {
            success: false,
            message: '❌ An error occurred while fetching issues. Please try again later.'
        };
    }
};

// Register the /issues command
bot.onText(/\/issues/, async (msg) => {
    const chatId = msg.chat.id;

    // Send initial processing message
    await bot.sendMessage(chatId, 'Fetching latest todo & inprogress issues, please wait...');

    // Handle the command
    const result = await handleIssuesCommand(chatId);

    // Send the response
    await bot.sendMessage(
        chatId,
        result.message,
        result.success ? { parse_mode: 'Markdown' } : {}
    );
});


// Schedule dailyupdates at 9 AM
cron.schedule('0 6 * * *', async () => {
    logger.info(`Sending morning update to chat ID: ${DAILY_CHAT_ID}`);
    logger.debug(`Morning update triggered at ${new Date().toISOString()}`);

    const issues = await fetchSortedIssues();

    if (issues.length > 0) {
        const issueLines = issues.map(issue => {
            const stateEmoji = issue.state === IN_PROGRESS_STATE ? '🏃' : '📋';
            const priorityEmojis = {
                'urgent': '🔴',
                'high': '🟠',
                'medium': '🟡',
                'low': '🟢',
                'none': '⚪'
            };
            const priorityEmoji = priorityEmojis[issue.priority] || '⚪';
            const dueDate = issue.target_date ? new Date(issue.target_date).toLocaleDateString() : 'No due date';
            return `${stateEmoji} ${priorityEmoji} *${issue.name}*\nDue: 📅 ${dueDate}`;
        });

        const message = `🌅 *Good Morning! Here are the Active Issues:*\n\n${issueLines.join('\n\n')}`;
        try {
            await bot.sendMessage(DAILY_CHAT_ID, message, { parse_mode: 'Markdown' });
        } catch (error) {
            if (error.code === 'ETELEGRAM' && error.response?.statusCode === 400) {
                logger.warn(`Failed to send daily update: ${error.message}`);
                // Try sending without markdown if parsing failed
                try {
                    await bot.sendMessage(DAILY_CHAT_ID, message.replace(/[*_`]/g, ''));
                } catch (retryError) {
                    logger.error(`Failed to send plain daily update: ${retryError.message}`);
                }
            } else {
                logger.error(`Unexpected error: ${error.message}`);
                throw error;
            }
        }
    } else {
        bot.sendMessage(DAILY_CHAT_ID, '⚠️ No active issues found.');
    }
});

// Schedule evening status report at 9 PM
cron.schedule('20 21 * * *', async () => {
    logger.info(`Sending evening status update to chat ID: ${DAILY_CHAT_ID}`);

    try {
        // Get status data
        const statusData = cache.get('statusData') || await refreshAllCaches();

        // Get active issues
        const issues = await fetchSortedIssues();

        // Format status message
        const getStateEmoji = (state) => {
            switch (state) {
                case IN_PROGRESS_STATE: return '🏃';
                case TODO_STATE: return '📋';
                case DONE_STATE: return '✅';
                case BACKLOG_STATE: return '📝';
                default: return '❓';
            }
        };

        const todayIssuesFormatted = (statusData.todayIssues || [])
            .map(issue => {
                const stateEmoji = getStateEmoji(issue.state);
                const priorityEmoji = getPriorityEmoji(issue.priority);
                return `${stateEmoji} ${priorityEmoji} ${issue.name}`;
            })
            .join('\n');

        // Prepare active issues section
        let activeIssuesSection = '';
        if (issues.length > 0) {
            const issueLines = issues.map(issue => {
                const stateEmoji = issue.state === IN_PROGRESS_STATE ? '🏃' : '📋';
                const priorityEmojis = {
                    'urgent': '🔴',
                    'high': '🟠',
                    'medium': '🟡',
                    'low': '🟢',
                    'none': '⚪'
                };
                const priorityEmoji = priorityEmojis[issue.priority] || '⚪';
                return `${stateEmoji} ${priorityEmoji} *${issue.name}*`;
            });

            activeIssuesSection = `

🎯 *Current Active Issues:*
${issueLines.join('\n')}`;
        }

        // Send combined status update
        // Get daily tasks
        const dailyTasks = await loadDailyTasks();
        const dailiesFormatted = dailyTasks.tasks
            .map(task => `${task.completed ? '✅' : '⬜'} ${task.text}`)
            .join('\n');

        const statusMessage = `
🌙 *Evening Status Report*

📊 *Current ${PROJECT_NAME} Dev Cycle Status:*
🏃 In Progress: ${statusData.inProgress} tasks
📋 Todo: ${statusData.todo} tasks
✅ Completed: ${statusData.done} tasks
📝 Backlog: ${statusData.backlog} tasks
━━━━━━━━━━━━━━━━
📈 Total: ${statusData.total} tasks

📋 *Daily Tasks Progress:*
${dailiesFormatted || "No daily tasks set"}

📅 *Updated Today (${statusData.todayIssues.length} issues):*
${todayIssuesFormatted || "No issues updated today"}${activeIssuesSection}`;

        bot.sendMessage(DAILY_CHAT_ID, statusMessage, { parse_mode: 'Markdown' });
    } catch (error) {
        logger.error(`Error sending evening status update: ${error.message}`);
        bot.sendMessage(DAILY_CHAT_ID, '❌ An error occurred while generating the evening status report.');
    }
});

// Handler for displaying completed issues
const handleCompletedCommand = async (chatId) => {
    logger.info(`Handling /completed command for chat ID: ${chatId}`);

    try {
        // Get cached status data or refresh if needed
        let statusData = cache.get('statusData');
        if (!statusData) {
            await refreshAllCaches();
            statusData = cache.get('statusData');
        }

        const completedIssues = statusData.allIssues
            .filter(issue => issue.state === DONE_STATE)
            .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))
            .slice(0, 10); // Get top 10 most recently completed

        if (completedIssues.length > 0) {
            const issueLines = completedIssues.map(issue => {
                const completedDate = new Date(issue.updated_at).toLocaleString();
                const priorityEmoji = getPriorityEmoji(issue.priority);
                return `✅ ${priorityEmoji} *${issue.name}*\nCompleted: 🕒 ${completedDate}`;
            });

            return {
                success: true,
                message: `🎉 *Recently Completed Tasks:*\n\n${issueLines.join('\n\n')}`
            };
        } else {
            return {
                success: true,
                message: '📝 No completed tasks found.'
            };
        }
    } catch (error) {
        logger.error(`Error fetching completed issues: ${error.message}`);
        return {
            success: false,
            message: '❌ An error occurred while fetching completed issues. Please try again later.'
        };
    }
};

// Register direct issue management commands
bot.onText(/\/add/, async (msg) => {
    const chatId = msg.chat.id;
    logger.info(`Received /add command from chat ID: ${chatId}`);

    conversationState.set(chatId, { state: 'awaiting_issue_name' });
    await bot.sendMessage(chatId, 'Please enter the name of the new issue:');
});

bot.onText(/\/edit/, async (msg) => {
    const chatId = msg.chat.id;
    logger.info(`Received /edit command from chat ID: ${chatId}`);

    try {
        let statusData = cache.get('statusData');
        if (!statusData) {
            statusData = await refreshAllCaches();
        }
        const issues = statusData.allIssues;
        const keyboard = issues.map(issue => ([{
            text: issue.name,
            callback_data: `edit_issue_${issue.id}`
        }]));

        await bot.sendMessage(
            chatId,
            'Select an issue to edit:',
            {
                reply_markup: { inline_keyboard: keyboard }
            }
        );
    } catch (error) {
        logger.error(`Error fetching issues for edit: ${error.message}`);
        await bot.sendMessage(chatId, '❌ Failed to fetch issues. Please try again.');
    }
});

bot.onText(/\/delete/, async (msg) => {
    const chatId = msg.chat.id;
    logger.info(`Received /delete command from chat ID: ${chatId}`);

    try {
        let statusData = cache.get('statusData');
        if (!statusData) {
            statusData = await refreshAllCaches();
        }
        const issues = statusData.allIssues;
        const keyboard = issues.map(issue => ([{
            text: `🗑️ ${issue.name}`,
            callback_data: `delete_issue_${issue.id}`
        }]));

        await bot.sendMessage(
            chatId,
            'Select an issue to delete:',
            {
                reply_markup: { inline_keyboard: keyboard }
            }
        );
    } catch (error) {
        logger.error(`Error fetching issues for deletion: ${error.message}`);
        await bot.sendMessage(chatId, '❌ Failed to fetch issues. Please try again.');
    }
});

// Register the /completed command
bot.onText(/\/completed/, async (msg) => {
    const chatId = msg.chat.id;

    // Send initial processing message
    await bot.sendMessage(chatId, 'Fetching completed issues, please wait...');

    // Handle the command
    const result = await handleCompletedCommand(chatId);

    // Send the response
    await bot.sendMessage(
        chatId,
        result.message,
        result.success ? { parse_mode: 'Markdown' } : {}
    );
});

// Handle polling errors
bot.on('polling_error', (error) => {
    logger.error(`Polling error: ${error.code} - ${error.message}`);
    logger.debug(`Full polling error details: ${JSON.stringify(error)}`);
});

// Save cache before exit
process.on('SIGINT', () => {
    logger.info('Received SIGINT. Saving cache before exit...');
    cache.saveToDisk();
    process.exit(0);
});

process.on('SIGTERM', () => {
    logger.info('Received SIGTERM. Saving cache before exit...');
    cache.saveToDisk();
    process.exit(0);
});

// Optimize message logging to avoid excessive logs
bot.on('message', (msg) => {
    if (msg.text && msg.text.startsWith('/')) {
        logger.info(`Received command: ${msg.text} from chat ID: ${msg.chat.id}`);
    }
});

