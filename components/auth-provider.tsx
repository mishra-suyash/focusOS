"use client";

import { onAuthStateChanged, signInAnonymously, signInWithPopup, signOut, type User } from "firebase/auth";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { auth, googleProvider, isFirebaseConfigured } from "@/lib/firebase";
import { upsertUser } from "@/lib/firestore";

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  isDemoMode: boolean;
  signInWithGoogle: () => Promise<void>;
  signInAsGuest: () => Promise<void>;
  logOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
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
      if (currentUser) {
        await upsertUser(currentUser.uid, {
          displayName: currentUser.displayName ?? "FocusOS Scholar",
          email: currentUser.email ?? "guest@focusos.dev",
          photoURL: currentUser.photoURL ?? undefined
        });
      }
    });
  }, []);

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
      isDemoMode: !isFirebaseConfigured,
      signInWithGoogle: async () => {
        if (!auth) return;
        await signInWithPopup(auth, googleProvider);
      },
      signInAsGuest: async () => {
        if (!auth) return;
        await signInAnonymously(auth);
      },
      logOut: async () => {
        if (auth) await signOut(auth);
      }
    }),
    [loading, user]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}
