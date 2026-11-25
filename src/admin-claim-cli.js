/**
 * Standalone CLI for managing the Firebase Auth `admin: true` custom claim (ADR 0014, Issue #58).
 * Grants, revokes, or inspects Admin claims on a Firebase Auth user by email or UID.
 */

import { pathToFileURL } from 'node:url';
import { loadDotEnv } from './places-sync.js';

const VALID_ACTIONS = ['grant', 'revoke', 'inspect'];

function readFlagValue(argv, index, flagName) {
  const arg = argv[index];
  if (arg.startsWith(`${flagName}=`)) {
    return { value: arg.slice(flagName.length + 1), nextIndex: index };
  }
  const next = argv[index + 1];
  if (next === undefined || next.startsWith('--')) {
    throw new Error(`${flagName} must be a non-empty string.`);
  }
  return { value: next, nextIndex: index + 1 };
}

function requireNonEmpty(value, flagName) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) {
    throw new Error(`${flagName} must be a non-empty string.`);
  }
  return trimmed;
}

/**
 * Parses and validates CLI arguments for the Admin claim CLI.
 *
 * @param {Array<string>} [argv=process.argv.slice(2)]
 * @param {object} [env=process.env]
 * @returns {{ action: 'grant'|'revoke'|'inspect', target: { email?: string, uid?: string }, project: string, useAdc: boolean }}
 */
export function parseCliArgs(argv = process.argv.slice(2), env = process.env) {
  const actions = [];
  let email;
  let uid;
  let project = env.FIREBASE_PROJECT_ID || 'myplaydex';
  let useAdc = env.FIREBASE_USE_ADC === 'true';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--grant' || arg === '--revoke' || arg === '--inspect') {
      actions.push(arg.slice(2));
    } else if (arg === '--use-adc') {
      useAdc = true;
    } else if (arg === '--email' || arg.startsWith('--email=')) {
      const parsed = readFlagValue(argv, i, '--email');
      email = parsed.value;
      i = parsed.nextIndex;
    } else if (arg === '--uid' || arg.startsWith('--uid=')) {
      const parsed = readFlagValue(argv, i, '--uid');
      uid = parsed.value;
      i = parsed.nextIndex;
    } else if (arg === '--project' || arg.startsWith('--project=')) {
      const parsed = readFlagValue(argv, i, '--project');
      project = parsed.value;
      i = parsed.nextIndex;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (actions.length === 0) {
    throw new Error(`Missing action flag. Specify one of: ${VALID_ACTIONS.map(a => `--${a}`).join(', ')}.`);
  }
  if (actions.length > 1) {
    throw new Error('Specify exactly one action: --grant, --revoke, or --inspect.');
  }

  if (email === undefined && uid === undefined) {
    throw new Error('Target user is required: specify --email=<email> or --uid=<uid>.');
  }
  if (email !== undefined && uid !== undefined) {
    throw new Error('Cannot specify both --email and --uid.');
  }

  const target = email !== undefined
    ? { email: requireNonEmpty(email, '--email') }
    : { uid: requireNonEmpty(uid, '--uid') };

  return {
    action: actions[0],
    target,
    project: project.trim() || 'myplaydex',
    useAdc
  };
}

/**
 * Looks up a Firebase Auth user by email or UID and applies or inspects the `admin` custom claim.
 *
 * @param {object} params
 * @param {object} params.auth - Firebase Admin Auth instance
 * @param {{ email?: string, uid?: string }} params.target
 * @param {'grant'|'revoke'|'inspect'} params.action
 * @returns {Promise<{ action: string, uid: string, email: string | null, claims: object }>}
 */
export async function applyAdminClaim({ auth, target, action }) {
  if (!auth || typeof auth.setCustomUserClaims !== 'function') {
    throw new Error('Firebase Admin Auth client is required.');
  }

  const user = target?.email
    ? await auth.getUserByEmail(target.email)
    : await auth.getUser(target?.uid);

  const existingClaims = user.customClaims && typeof user.customClaims === 'object'
    ? { ...user.customClaims }
    : {};

  if (action === 'inspect') {
    return {
      action,
      uid: user.uid,
      email: user.email ?? null,
      claims: existingClaims
    };
  }

  let nextClaims;
  if (action === 'grant') {
    nextClaims = { ...existingClaims, admin: true };
  } else if (action === 'revoke') {
    const { admin: _removed, ...rest } = existingClaims;
    nextClaims = rest;
  } else {
    throw new Error(`Unsupported action: ${action}`);
  }

  await auth.setCustomUserClaims(user.uid, nextClaims);

  return {
    action,
    uid: user.uid,
    email: user.email ?? null,
    claims: nextClaims
  };
}

/**
 * Initializes Firebase Admin Auth from `FIREBASE_SERVICE_ACCOUNT_KEY` or ADC.
 *
 * @param {object} [env=process.env]
 * @param {{ useAdc?: boolean, projectId?: string }} [options={}]
 * @returns {Promise<object>} Firebase Admin Auth instance
 */
export async function initAdminAuthFromEnv(env = process.env, options = {}) {
  const adminApp = await import('firebase-admin/app');
  const adminAuth = await import('firebase-admin/auth');

  if (adminApp.getApps().length > 0) {
    return adminAuth.getAuth(adminApp.getApps()[0]);
  }

  const rawKey = env.FIREBASE_SERVICE_ACCOUNT_KEY;
  const projectId = options.projectId || env.FIREBASE_PROJECT_ID || 'myplaydex';

  if (rawKey) {
    const trimmed = rawKey.trim();
    const json = trimmed.startsWith('{')
      ? trimmed
      : Buffer.from(trimmed, 'base64').toString('utf8');
    const credentials = JSON.parse(json);
    const app = adminApp.initializeApp({
      credential: adminApp.cert(credentials),
      projectId: credentials.project_id || projectId
    });
    return adminAuth.getAuth(app);
  }

  if (options.useAdc || env.FIREBASE_USE_ADC === 'true') {
    const app = adminApp.initializeApp({
      credential: adminApp.applicationDefault(),
      projectId
    });
    return adminAuth.getAuth(app);
  }

  throw new Error('Missing Firebase Admin credentials: set FIREBASE_SERVICE_ACCOUNT_KEY or pass --use-adc.');
}

/**
 * Main entry point for the Admin custom-claim CLI.
 *
 * @param {Array<string>} [argv=process.argv.slice(2)]
 * @param {object} [env=process.env]
 * @param {object} [options={}]
 * @returns {Promise<{ action: string, uid: string, email: string | null, claims: object }>}
 */
export async function main(argv = process.argv.slice(2), env = process.env, options = {}) {
  if (env === process.env || options.envFilePath) {
    await loadDotEnv(options.envFilePath, env);
  }

  const parsedArgs = parseCliArgs(argv, env);
  const logger = options.logger || console;
  const auth = options.auth || await initAdminAuthFromEnv(env, {
    useAdc: parsedArgs.useAdc,
    projectId: parsedArgs.project
  });

  const result = await applyAdminClaim({
    auth,
    target: parsedArgs.target,
    action: parsedArgs.action
  });

  logger.log?.(
    `[Admin Claim CLI] ${result.action} completed for uid=${result.uid} (email=${result.email ?? 'none'}) claims=${JSON.stringify(result.claims)}`
  );

  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error(`[Admin Claim CLI Error] ${err.message}`);
    process.exit(1);
  });
}
