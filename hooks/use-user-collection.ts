"use client";

import { orderBy, type QueryConstraint } from "firebase/firestore";
import { useEffect, useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { subscribeCollection } from "@/lib/firestore";

export function useUserCollection<T extends { id: string }>(
  name: string,
  constraints: QueryConstraint[] = [orderBy("createdAt", "desc")]
) {
  const { user } = useAuth();
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) {
      setItems([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const unsubscribe = subscribeCollection<T>(
      user.uid,
      name,
      (next) => {
        setItems(next);
        setLoading(false);
      },
      constraints
    );
    return unsubscribe;
  }, [constraints, name, user]);

  return { items, loading };
}
