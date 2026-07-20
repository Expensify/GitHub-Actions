const KNOWN_BOT_USERS = new Set(['botify', 'MelvinBot', 'exfy-zapier', 'OSBotify', 'CLABotify']);

function isBotUser(login: string): boolean {
    if (login.endsWith('[bot]')) {
        return true;
    }

    return KNOWN_BOT_USERS.has(login);
}

export default isBotUser;
