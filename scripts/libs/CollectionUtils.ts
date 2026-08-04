function uniqueSorted(values: string[]): string[] {
    return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

async function filterAsync<T>(items: T[], predicate: (item: T) => Promise<boolean>): Promise<T[]> {
    const matches = await Promise.all(items.map((item) => predicate(item)));
    return items.filter((_item, index) => matches.at(index));
}

export default {
    uniqueSorted,
    filterAsync,
};
