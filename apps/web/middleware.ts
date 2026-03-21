import { NextResponse, type NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";

const allowPath = (pathname: string) => pathname.startsWith("/ops/login");

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (!pathname.startsWith("/ops")) return NextResponse.next();
  if (allowPath(pathname)) return NextResponse.next();

  let token = null;
  try {
    token = await getToken({ req: request, secret: process.env.NEXTAUTH_SECRET });
  } catch {
    // NEXTAUTH_SECRET missing or token parse error - treat as unauthenticated
  }
  if (token?.isOpsAdmin) return NextResponse.next();

  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/ops/login";
  loginUrl.searchParams.set("next", pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest).*)"],
};
