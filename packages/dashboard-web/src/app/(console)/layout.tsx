import { Console } from "@/components/shell/console";

export default function ConsoleLayout({ children }: { children: React.ReactNode }) {
  return <Console>{children}</Console>;
}
