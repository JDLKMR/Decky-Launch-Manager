import { toaster } from "@decky/api";

export const toast = (body: string) => toaster.toast({ title: "Launch Manager", body });
