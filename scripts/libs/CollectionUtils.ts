function uniqueSorted(values: string[]): string[] {
    return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

export default {
    uniqueSorted,
};
