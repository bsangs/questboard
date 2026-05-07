"use client";

import { useEffect } from "react";
import { Board } from "@/components/Board";
import { useBoard } from "@/lib/state";

export default function CardDeepLink({ params }: { params: { id: string } }) {
  const openDrawer = useBoard((s) => s.openDrawer);
  useEffect(() => {
    openDrawer(params.id);
  }, [params.id, openDrawer]);
  return <Board />;
}
