import { UnauthenticatedUser, type User } from '@a2a-js/sdk/server';
import { type HttpServerRequest } from 'effect/unstable/http';

export type EffectUserBuilder = (request: HttpServerRequest.HttpServerRequest) => Promise<User>;

export const UserBuilder = {
  noAuthentication: async (_request: HttpServerRequest.HttpServerRequest): Promise<User> =>
    new UnauthenticatedUser(),
};
