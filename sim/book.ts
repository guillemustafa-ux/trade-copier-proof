export interface BookLogin {
  name: string;
  password: string;
  accountIds: number[];
}
export interface BookAccount {
  id: number;
  name: string;
  login: string;
}
export interface Book {
  master: { login: string; password: string; accountId: number };
  logins: BookLogin[];
  accounts: BookAccount[];
}

export const SIM_PASSWORD = 'sim-password'; // the simulator's only credential; not a secret
export const FIRST_ACCOUNT_ID = 1001;

/** One master account plus `accounts` followers spread evenly over `logins`. */
export function makeBook(opts: { logins: number; accounts: number }): Book {
  const perLogin = Math.ceil(opts.accounts / opts.logins);
  const logins: BookLogin[] = [];
  const accounts: BookAccount[] = [];
  for (let l = 0; l < opts.logins; l++) {
    const name = `login-${String(l + 1).padStart(2, '0')}`;
    const accountIds: number[] = [];
    for (let a = 0; a < perLogin && accounts.length < opts.accounts; a++) {
      const id = FIRST_ACCOUNT_ID + accounts.length;
      accountIds.push(id);
      accounts.push({ id, name: `FOLLOWER${id}`, login: name });
    }
    logins.push({ name, password: SIM_PASSWORD, accountIds });
  }
  return { master: { login: 'master', password: SIM_PASSWORD, accountId: 1 }, logins, accounts };
}
