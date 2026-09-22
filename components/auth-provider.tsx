"use client";

import {
  createUserWithEmailAndPassword,
  isSignInWithEmailLink,
  onAuthStateChanged,
  signInAnonymously,
  signInWithEmailAndPassword,
  signInWithEmailLink,
  signInWithPopup,
  sendSignInLinkToEmail,
  signOut,
  type User
} from "firebase/auth";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { auth, googleProvider, isFirebaseConfigured } from "@/lib/firebase";
import { upsertUser } from "@/lib/firestore";
import { setUsageUid } from "@/lib/usage";
import type { UserRole } from "@/types";

const MAGIC_LINK_EMAIL_KEY = "focusos-magic-link-email";

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  isDemoMode: boolean;
  /** Custom-claim role (admin panel §2) — null until the first ID token is read, "member" for any signed-in account with no claim set yet. */
  role: UserRole | null;
  /** Set when the bootstrap call rejects a brand-new signup under admin/settings.signupMode ("invite"/"closed") — the account was already signed out server-side by then. `/login` surfaces this and clears it once shown. */
  signupBlockedMessage: string | null;
  clearSignupBlockedMessage: () => void;
  signInWithGoogle: () => Promise<void>;
  signInAsGuest: () => Promise<void>;
  signUpWithEmail: (email: string, password: string) => Promise<void>;
  signInWithEmail: (email: string, password: string) => Promise<void>;
  sendMagicLink: (email: string) => Promise<void>;
  logOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [role, setRole] = useState<UserRole | null>(null);
  const [signupBlockedMessage, setSignupBlockedMessage] = useState<string | null>(null);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!auth) {
      setLoading(false);
      return;
    }
    return onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      setLoading(false);
      setUsageUid(currentUser?.uid ?? null);
      if (currentUser) {
        await upsertUser(currentUser.uid, {
          displayName: currentUser.displayName ?? (currentUser.isAnonymous ? "Guest" : "FocusOS Scholar"),
          email: currentUser.email ?? "",
          photoURL: currentUser.photoURL ?? undefined
        });
        // Bootstraps the owner claim / claims a pending invite, then re-reads the
        // token in case either just changed the role claim (admin panel §2).
        try {
          const token = await currentUser.getIdToken();
          const response = await fetch("/api/admin/bootstrap", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
          if (response.status === 403) {
            const body = await response.json().catch(() => ({}));
            setSignupBlockedMessage(body.error || "New sign-ups are currently restricted.");
            if (auth) await signOut(auth);
            return;
          }
        } catch {
          // Best-effort — a failed bootstrap call never blocks sign-in.
        }
        const tokenResult = await currentUser.getIdTokenResult(true);
        setRole((tokenResult.claims.role as UserRole | undefined) ?? "member");
      } else {
        setRole(null);
      }
    });
  }, []);

  // Completes a magic-link sign-in when the user opens the link Firebase emailed them.
  useEffect(() => {
    if (!auth || typeof window === "undefined") return;
    if (!isSignInWithEmailLink(auth, window.location.href)) return;
    (async () => {
      let email = window.localStorage.getItem(MAGIC_LINK_EMAIL_KEY);
      if (!email) {
        email = window.prompt("Confirm the email address you requested the sign-in link with:");
      }
      if (!email) return;
      await signInWithEmailLink(auth, email, window.location.href);
      window.localStorage.removeItem(MAGIC_LINK_EMAIL_KEY);
      router.replace("/dashboard");
    })();
  }, [router]);

  useEffect(() => {
    if (loading) return;
    const publicRoute = pathname === "/login";
    if (!user && !publicRoute) router.replace("/login");
    if (user && publicRoute) router.replace("/dashboard");
  }, [loading, pathname, router, user]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      role,
      signupBlockedMessage,
      clearSignupBlockedMessage: () => setSignupBlockedMessage(null),
      isDemoMode: !isFirebaseConfigured,
      signInWithGoogle: async () => {
        if (!auth) return;
        await signInWithPopup(auth, googleProvider);
      },
      signInAsGuest: async () => {
        if (!auth) return;
        await signInAnonymously(auth);
      },
      signUpWithEmail: async (email: string, password: string) => {
        if (!auth) return;
        await createUserWithEmailAndPassword(auth, email, password);
      },
      signInWithEmail: async (email: string, password: string) => {
        if (!auth) return;
        await signInWithEmailAndPassword(auth, email, password);
      },
      sendMagicLink: async (email: string) => {
        if (!auth || typeof window === "undefined") return;
        await sendSignInLinkToEmail(auth, email, { url: `${window.location.origin}/login`, handleCodeInApp: true });
        window.localStorage.setItem(MAGIC_LINK_EMAIL_KEY, email);
      },
      logOut: async () => {
        if (auth) await signOut(auth);
      }
    }),
    [loading, user, role, signupBlockedMessage]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}
