import { adminClient, deviceAuthorizationClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';
import { apiOrigin } from '@/lib/api';

export const authClient = createAuthClient({
  baseURL: apiOrigin,
  fetchOptions: {
    credentials: 'include',
  },
  plugins: [adminClient(), deviceAuthorizationClient()],
});

export type AuthRole = 'admin' | 'user';
