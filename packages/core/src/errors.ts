export class CnosError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class CnosManifestError extends CnosError {
  constructor(message: string, readonly manifestPath?: string) {
    super(manifestPath ? `${message} (${manifestPath})` : message);
  }
}

export class CnosDiscoveryError extends CnosError {
  constructor(message: string) {
    super(message);
  }
}

export class CnosSecurityError extends CnosError {
  constructor(message: string) {
    super(message);
  }
}

export class CnosAuthenticationError extends CnosError {
  constructor(message: string) {
    super(message);
  }
}

export class CnosKeyNotFoundError extends CnosError {
  constructor(readonly key: string) {
    super(`Missing required CNOS config key: ${key}`);
  }
}
