# 🛫 Plane.so Telegram Bot

A powerful Telegram bot that seamlessly integrates with Plane.so to provide task management and project status updates right in your chat! 🚀

## ✨ Features

- 🔄 Real-time task status updates
- 📊 Daily morning and evening reports
- ⭐ Priority-based task sorting
- ⚡ Caching system for improved performance
- 🔁 Automatic retry mechanism for API calls
- 📝 Detailed logging system

## 🤖 Commands

- `/issues` - Show top 10 active tasks (in progress & todo)
- `/completed` - Show recently completed tasks
- `/status` - Show project status summary
- `/stats` - Show project statistics
- `/help` - Show help message

## 📋 Prerequisites

- Node.js (v14 or higher)
- npm or yarn
- Telegram Bot Token (Get it from [@BotFather](https://t.me/botfather))
- Plane.so API Token (Find it in your Plane.so account settings)

## 🚀 Installation

1. Clone the repository:
    ```
   git clone https://github.com/yourusername/plane-telegram-bot.git
   cd plane-telegram-bot
   ```

2. Install dependencies:
   ```bash
   npm install
   # or
   yarn install
   ```

3. Create a `.env` file in the root directory:
   ```env
   TELEGRAM_BOT_TOKEN=your_telegram_bot_token
   PLANE_API_TOKEN=your_plane_api_token
   PLANE_WORKSPACE_ID=your_workspace_id
   ```

4. Start the bot:
   ```bash
   npm start
   # or
   yarn start
   ```

## 🛠️ Configuration

You can customize the bot's behavior by modifying the `config.js` file:
- Change report scheduling times
- Adjust cache duration
- Modify task fetch limits
- Configure retry attempts

## 📚 Documentation

For more detailed information about the bot's features and configuration options, check out our [Wiki](https://github.com/yourusername/plane-telegram-bot/wiki).

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## ⭐ Support

If you find this bot helpful, please give it a star on GitHub! ⭐


