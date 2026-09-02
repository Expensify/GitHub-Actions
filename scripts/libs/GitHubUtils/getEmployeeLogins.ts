import type GitHubAPIClient from '../GitHubAPIClient';
import getTeamMemberLogins from './getTeamMemberLogins';

const EXPENSIFY_EMPLOYEE_TEAM_SLUG = 'expensify-expensify';

// Memoize the employee fetch list per client so that it happens at most once per client.
const employeeLoginsPromisesByClient = new WeakMap<GitHubAPIClient, Promise<Set<string>>>();

/**
 * This exists largely to replace Web-Expensify's Whitelist lookup, which we can't directly replace in open source.
 * So our authoritative source for "is this an Expensify employee" is this GitHub Team
 * which is meant to include all Expensify employees: https://github.com/orgs/Expensify/teams/expensify-expensify
 */
async function getEmployeeLogins(client: GitHubAPIClient): Promise<Set<string>> {
    let employeeLoginsPromise = employeeLoginsPromisesByClient.get(client);
    if (!employeeLoginsPromise) {
        employeeLoginsPromise = fetchEmployeeLogins(client);
        employeeLoginsPromisesByClient.set(client, employeeLoginsPromise);
    }

    return employeeLoginsPromise;
}

async function fetchEmployeeLogins(client: GitHubAPIClient): Promise<Set<string>> {
    return getTeamMemberLogins(client, EXPENSIFY_EMPLOYEE_TEAM_SLUG);
}

async function isExpensifyEmployee(client: GitHubAPIClient, login: string): Promise<boolean> {
    const employeeLogins = await getEmployeeLogins(client);
    return employeeLogins.has(login);
}

export default getEmployeeLogins;
export {isExpensifyEmployee};
