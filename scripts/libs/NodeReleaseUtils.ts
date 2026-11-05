const NODE_DIST_INDEX_URL = 'https://nodejs.org/dist/index.json';

const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

type NodeRelease = {
    /** Version without the leading "v", for example "26.12.1" */
    version: string;

    /** Version of npm bundled with this release */
    npm: string;

    /** Whether this release fixes a security vulnerability */
    security: boolean;

    /** Release date, for example "2026-10-21" */
    date: string;
};

type NodeDistIndexEntry = {
    version: string;
    npm?: string;
    security: boolean;
    date: string;
};

type BumpTarget = {status: 'bump'; from: NodeRelease; to: NodeRelease} | {status: 'up-to-date'; version: string} | {status: 'skipped'; reason: string};

function parseNodeReleases(entries: NodeDistIndexEntry[]): NodeRelease[] {
    // Releases from before Node.js bundled npm have no npm version, and no repo pins one of them.
    return entries.flatMap((entry) => (entry.npm ? [{version: entry.version.replace(/^v/, ''), npm: entry.npm, security: entry.security, date: entry.date}] : []));
}

async function fetchNodeReleases(): Promise<NodeRelease[]> {
    const response = await fetch(NODE_DIST_INDEX_URL);
    if (!response.ok) {
        throw new Error(`Failed to fetch ${NODE_DIST_INDEX_URL}: ${response.status} ${response.statusText}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- shape documented at https://github.com/nodejs/nodejs-dist-indexer
    return parseNodeReleases((await response.json()) as NodeDistIndexEntry[]);
}

/**
 * Turns a version such as "v26.12.1" into "26.12.1". Returns null when it isn't an exact version, such as "lts/*" or "24".
 */
function normalizeNodeVersion(rawVersion: string): string | null {
    const version = rawVersion.trim().replace(/^v/, '');
    return EXACT_VERSION_PATTERN.test(version) ? version : null;
}

function getMajor(version: string): number {
    return Number(version.split('.').at(0));
}

function compareVersions(a: string, b: string): number {
    const aParts = a.split('.').map(Number);
    const bParts = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        const difference = (aParts.at(i) ?? 0) - (bParts.at(i) ?? 0);
        if (difference !== 0) {
            return difference;
        }
    }
    return 0;
}

/**
 * Returns the releases on the same major line as `version` that are newer than it, newest first.
 */
function getNewerReleasesOnLine(releases: NodeRelease[], version: string): NodeRelease[] {
    return releases
        .filter((release) => getMajor(release.version) === getMajor(version) && compareVersions(release.version, version) > 0)
        .sort((a, b) => compareVersions(b.version, a.version));
}

/**
 * Whether any release after `from`, up to and including `to`, fixes a security vulnerability.
 */
function includesSecurityFix(releases: NodeRelease[], from: NodeRelease, to: NodeRelease): boolean {
    return getNewerReleasesOnLine(releases, from.version).some((release) => release.security && compareVersions(release.version, to.version) <= 0);
}

/**
 * Returns the newest security release on each of `majors` that came out in the last `maxAgeDays` days, newest line first.
 */
function findRecentSecurityReleases(releases: NodeRelease[], majors: number[], now: Date, maxAgeDays: number): NodeRelease[] {
    const maxAgeMilliseconds = maxAgeDays * MILLISECONDS_PER_DAY;
    const cutoff = now.getTime() - maxAgeMilliseconds;
    return [...new Set(majors)]
        .sort((a, b) => b - a)
        .flatMap((major) => {
            const newestSecurityRelease = releases
                .filter((release) => release.security && getMajor(release.version) === major)
                .sort((a, b) => compareVersions(b.version, a.version))
                .at(0);
            return newestSecurityRelease && Date.parse(newestSecurityRelease.date) >= cutoff ? [newestSecurityRelease] : [];
        });
}

/**
 * Finds the releases for a comma-separated list of versions passed on the command line, such as "26.13.1,24.22.3".
 * Allows at most one version per major line. An empty list means no release was requested.
 */
function findRequestedReleases(releases: NodeRelease[], requestedVersions: string): NodeRelease[] {
    const requestedReleases = requestedVersions
        .split(',')
        .map((requestedVersion) => requestedVersion.trim())
        .filter(Boolean)
        .map((requestedVersion) => {
            const version = normalizeNodeVersion(requestedVersion);
            const release = releases.find((candidate) => candidate.version === version);
            if (!release) {
                throw new Error(`${requestedVersion} is not a published Node.js release`);
            }
            return release;
        });

    const majors = requestedReleases.map((release) => getMajor(release.version));
    if (new Set(majors).size !== majors.length) {
        throw new Error('Request at most one Node.js version per major line');
    }
    return requestedReleases;
}

/**
 * Picks the release to move `currentVersion` to: the requested release on its major line, or the newest release on that line when no release is requested.
 * Major upgrades need code changes, so they are left to a person.
 */
function resolveBumpTarget(releases: NodeRelease[], currentVersion: string, requestedReleases: NodeRelease[] = []): BumpTarget {
    const from = releases.find((release) => release.version === currentVersion);
    if (!from) {
        return {status: 'skipped', reason: `${currentVersion} is not a published Node.js release`};
    }

    let to: NodeRelease | undefined;
    if (requestedReleases.length > 0) {
        to = requestedReleases.find((release) => getMajor(release.version) === getMajor(currentVersion));
        if (!to) {
            return {status: 'skipped', reason: `No requested release on the Node.js ${getMajor(currentVersion)}.x line`};
        }
    } else {
        to = getNewerReleasesOnLine(releases, currentVersion).at(0);
    }

    if (!to || compareVersions(to.version, currentVersion) <= 0) {
        return {status: 'up-to-date', version: currentVersion};
    }

    return {status: 'bump', from, to};
}

function getReleaseNotesURL(version: string): string {
    return `https://nodejs.org/en/blog/release/v${version}`;
}

export type {BumpTarget, NodeDistIndexEntry, NodeRelease};

export default {
    compareVersions,
    fetchNodeReleases,
    findRecentSecurityReleases,
    findRequestedReleases,
    getMajor,
    getNewerReleasesOnLine,
    getReleaseNotesURL,
    includesSecurityFix,
    normalizeNodeVersion,
    parseNodeReleases,
    resolveBumpTarget,
};
