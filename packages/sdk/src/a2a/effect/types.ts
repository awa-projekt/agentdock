import { UnauthenticatedUser, type User } from '@a2a-js/sdk/server';
import type * as HttpServerRequest from 'effect/http/HttpServerRequest';

export type EffectUserBuilder = (request: HttpServerRequest.HttpServerRequest) => Promise<User>;

export const UserBuilder = {
  noAuthentication: async (_request: HttpServerRequest.HttpServerRequest): Promise<User> => new UnauthenticatedUser(),
};
