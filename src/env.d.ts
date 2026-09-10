/// <reference types="astro/client" />

import type { SessionState } from './lib/intranet/auth.ts';
import type { Profile } from './lib/intranet/data/types.ts';

declare global {
  namespace App {
    interface Locals {
      /** Set by src/middleware.ts on every /teamintranet request. */
      session?: SessionState;
      profile?: Profile;
    }
  }
}

interface ImportMetaEnv {
  readonly SUPABASE_URL?: string;
  readonly SUPABASE_ANON_KEY?: string;
  readonly INTRANET_ENABLED?: string;
  readonly INTRANET_DATA?: string;
  readonly INTRANET_EMAIL_DOMAIN?: string;
  readonly INTRANET_BOOTSTRAP_ADMINS?: string;
  /** Server-side only. Never exposed to a browser — the reader runs on the server. */
  readonly ANTHROPIC_API_KEY?: string;
  readonly AIRTABLE_API_KEY?: string;
  readonly AIRTABLE_BASE_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

export {};
