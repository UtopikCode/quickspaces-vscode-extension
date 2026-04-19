export function trimTrailingSlashes(value: string): string {
    let end = value.length;
    while (end > 0 && value[end - 1] === '/') {
        end -= 1;
    }
    return value.slice(0, end);
}

export function trimLeadingSlashes(value: string): string {
    let start = 0;
    while (start < value.length && value[start] === '/') {
        start += 1;
    }
    return value.slice(start);
}
