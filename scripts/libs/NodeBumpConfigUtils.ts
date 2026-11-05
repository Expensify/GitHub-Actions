import {readFileSync} from 'node:fs';

type NodeBumpRepo = {
    name: string;

    /** Prepended to the pull request title when the bump includes a security fix, for example "[CP Staging & Prod]" */
    securityReleaseTitlePrefix?: string;

    /** Jenkins builds this repo on the build boxes and checks the Node.js version there, so its pull request waits on HOLD until the build boxes are upgraded */
    holdForBuildBoxes?: boolean;
};

type NodeBumpConfig = {
    owner: string;

    /** Repo, under `owner`, where tracking issues for Node.js security releases are opened */
    trackingIssueRepo: string;

    trackingIssueLabels: string[];

    repos: NodeBumpRepo[];
};

const CONFIG_URL = new URL('../../config/nodeBump.json', import.meta.url);

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function parseRepo(value: unknown): NodeBumpRepo {
    if (!isRecord(value)) {
        throw new Error('Each repo must be an object');
    }

    const {name, securityReleaseTitlePrefix, holdForBuildBoxes, ...unknownKeys} = value;
    if (typeof name !== 'string' || !name) {
        throw new Error('Each repo needs a name');
    }
    if (securityReleaseTitlePrefix !== undefined && typeof securityReleaseTitlePrefix !== 'string') {
        throw new Error(`${name}: securityReleaseTitlePrefix must be a string`);
    }
    if (holdForBuildBoxes !== undefined && typeof holdForBuildBoxes !== 'boolean') {
        throw new Error(`${name}: holdForBuildBoxes must be a boolean`);
    }
    const unknownKeyNames = Object.keys(unknownKeys);
    if (unknownKeyNames.length > 0) {
        throw new Error(`${name}: unknown keys ${unknownKeyNames.join(', ')}`);
    }

    return {name, securityReleaseTitlePrefix, holdForBuildBoxes};
}

function parseNodeBumpConfig(value: unknown): NodeBumpConfig {
    if (!isRecord(value)) {
        throw new Error('The config must be an object');
    }

    const {owner, trackingIssueRepo, trackingIssueLabels, repos} = value;
    if (typeof owner !== 'string' || !owner) {
        throw new Error('owner must be a non-empty string');
    }
    if (typeof trackingIssueRepo !== 'string' || !trackingIssueRepo) {
        throw new Error('trackingIssueRepo must be a non-empty string');
    }
    if (!isStringArray(trackingIssueLabels)) {
        throw new Error('trackingIssueLabels must be an array of strings');
    }
    if (!Array.isArray(repos) || repos.length === 0) {
        throw new Error('repos must be a non-empty array');
    }

    const parsedRepos = repos.map(parseRepo);
    const duplicates = parsedRepos.filter((repo, index) => parsedRepos.findIndex((other) => other.name === repo.name) !== index);
    if (duplicates.length > 0) {
        throw new Error(`Repos listed more than once: ${duplicates.map((repo) => repo.name).join(', ')}`);
    }

    return {owner, trackingIssueRepo, trackingIssueLabels, repos: parsedRepos};
}

function loadNodeBumpConfig(): NodeBumpConfig {
    return parseNodeBumpConfig(JSON.parse(readFileSync(CONFIG_URL, 'utf8')));
}

export type {NodeBumpConfig, NodeBumpRepo};

export default {
    loadNodeBumpConfig,
    parseNodeBumpConfig,
};
