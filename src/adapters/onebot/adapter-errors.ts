export class AccountMismatchError extends Error {}

export class AdapterOfflineError extends Error {
  constructor(account: number) {
    super(`OneBot adapter ${account} is not online`);
    this.name = 'AdapterOfflineError';
  }
}
