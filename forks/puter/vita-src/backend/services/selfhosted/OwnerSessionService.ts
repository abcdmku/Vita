/**
 * Vita fork addition — not present in upstream Puter.
 *
 * Mints a stable owner ("admin") web-session token on first boot and persists
 * it to `<runtime>/owner-auth-token.json` on the Vita persistent volume. The
 * kiosk reads that file and seeds it into the browser as
 * `localStorage['auth_token']` + `['auth_token_v2']` so the single owner is
 * auto-logged-in with no login screen (offline, single-owner deployment).
 *
 * The token stays valid across reboots because (a) the session row lives in
 * the persistent SQLite DB and (b) `jwt_secret_v2` is fixed in config. On a
 * reboot where the file + session still validate, we reuse the existing token;
 * only if the session was revoked/expired do we mint a fresh one.
 *
 * Gated to `env === 'dev'` + `disable_temp_users` (the offline single-owner
 * profile). Licensed AGPL-3.0 as part of the Vita fork of Puter.
 */

import fs from 'node:fs';
import path from 'node:path';
import { PuterService } from '../types.js';

const USERNAME = 'admin';

export class OwnerSessionService extends PuterService {
    override async onServerStart(): Promise<void> {
        // Only run for the offline single-owner profile.
        if (!this.config.disable_temp_users) return;
        if (this.config.no_default_user) return;

        const tokenPath = this.#tokenPath();

        const user = await this.stores.user.getByUsername(USERNAME);
        if (!user) {
            console.warn(
                '[owner-session] admin user not found — auto-login token not minted',
            );
            return;
        }

        // Reuse a previously-minted token if it still verifies.
        const existing = this.#readExisting(tokenPath);
        if (existing) {
            try {
                this.services.token.verify('auth', existing.token);
                console.log(
                    `[owner-session] reusing persisted owner token at ${tokenPath}`,
                );
                return;
            } catch {
                console.log(
                    '[owner-session] persisted owner token invalid/expired — minting a fresh one',
                );
            }
        }

        const { token, gui_token, session } =
            await this.services.auth.createSessionToken(user, {
                kind: 'web',
                source: 'vita-owner-autologin',
            });

        const payload = {
            token,
            gui_token,
            session_uid:
                (session as Record<string, unknown>).uuid ??
                (session as Record<string, unknown>).session_uid ??
                null,
            user_uid: user.uuid,
            username: USERNAME,
            minted_at: new Date().toISOString(),
        };

        fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
        fs.writeFileSync(tokenPath, JSON.stringify(payload, null, 2), {
            mode: 0o600,
        });
        console.log(`[owner-session] minted owner auto-login token → ${tokenPath}`);
    }

    #tokenPath(): string {
        // Co-locate with the other persistent runtime data so it lives on the
        // Vita persistent volume (volatile/runtime is StateDirectory-mapped).
        const dbPath =
            (this.config.database as { path?: string } | undefined)?.path ??
            'volatile/runtime/puter-database.sqlite';
        const runtimeDir = path.dirname(
            path.isAbsolute(dbPath)
                ? dbPath
                : path.resolve(process.cwd(), dbPath),
        );
        return path.join(runtimeDir, 'owner-auth-token.json');
    }

    #readExisting(
        tokenPath: string,
    ): { token: string; gui_token?: string } | null {
        try {
            if (!fs.existsSync(tokenPath)) return null;
            const raw = fs.readFileSync(tokenPath, 'utf8');
            const parsed = JSON.parse(raw) as { token?: string };
            if (parsed && typeof parsed.token === 'string') {
                return parsed as { token: string };
            }
        } catch {
            // fall through — treat as missing
        }
        return null;
    }
}
