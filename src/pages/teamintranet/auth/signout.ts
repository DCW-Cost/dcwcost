import type { APIRoute } from 'astro';
import { serverClient, authConfigured } from '../../../lib/intranet/auth.ts';

export const prerender = false;

const signOut: APIRoute = async ({ cookies, request, redirect }) => {
  if (authConfigured) {
    await serverClient(cookies, request)!.auth.signOut();
  }
  return redirect('/teamintranet/signin', 302);
};

export const GET = signOut;
export const POST = signOut;
