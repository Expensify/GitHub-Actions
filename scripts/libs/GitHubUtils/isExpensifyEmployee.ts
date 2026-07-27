import getEmployeeLogins from './getEmployeeLogins';

async function isExpensifyEmployee(login: string): Promise<boolean> {
    const employeeLogins = await getEmployeeLogins();
    return employeeLogins.has(login);
}

export default isExpensifyEmployee;
