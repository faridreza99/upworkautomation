import { Switch, Route, Router as WouterRouter, Link, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import { Activity, Briefcase, LayoutDashboard, Settings, Bell, FileText, Radio } from "lucide-react";
import { Dashboard } from "./pages/dashboard";
import { Jobs } from "./pages/jobs";
import { JobDetail } from "./pages/job-detail";
import { Proposals } from "./pages/proposals";
import { Notifications } from "./pages/notifications";
import { SettingsPage } from "./pages/settings";
import { MonitorPage } from "./pages/monitor";

const queryClient = new QueryClient();

function Sidebar() {
  const [location] = useLocation();
  
  const links = [
    { href: "/", label: "Dashboard", icon: LayoutDashboard },
    { href: "/jobs", label: "Jobs", icon: Briefcase },
    { href: "/proposals", label: "Proposals", icon: FileText },
    { href: "/notifications", label: "Notifications", icon: Bell },
    { href: "/monitor", label: "Live Monitor", icon: Radio },
    { href: "/settings", label: "Settings", icon: Settings },
  ];

  return (
    <div className="w-64 border-r border-border bg-sidebar flex flex-col h-full">
      <div className="p-6 flex items-center gap-3">
        <div className="bg-primary/20 p-2 rounded-lg">
          <Activity className="text-primary w-6 h-6" />
        </div>
        <h1 className="font-serif font-bold text-xl tracking-tight text-sidebar-foreground">UpworkAI</h1>
      </div>
      <nav className="flex-1 px-4 space-y-1">
        {links.map(link => {
          const Icon = link.icon;
          const isActive = location === link.href || (link.href !== "/" && location.startsWith(link.href));
          return (
            <Link 
              key={link.href} 
              href={link.href} 
              className={`flex items-center gap-3 px-3 py-2.5 text-sm font-medium rounded-lg transition-colors ${
                isActive 
                  ? "bg-primary text-primary-foreground shadow-sm" 
                  : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              }`}
            >
              <Icon className="w-4 h-4" />
              {link.label}
            </Link>
          );
        })}
      </nav>
      <div className="p-4 mt-auto border-t border-sidebar-border">
        <div className="flex items-center gap-3 px-3 py-2 text-sm text-sidebar-foreground/70">
          <div className="w-2 h-2 rounded-full bg-emerald-500"></div>
          System Online
        </div>
      </div>
    </div>
  );
}

function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen bg-background text-foreground overflow-hidden">
      <Sidebar />
      <main className="flex-1 overflow-y-auto">
        {children}
      </main>
    </div>
  );
}

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/jobs" component={Jobs} />
        <Route path="/jobs/:id" component={JobDetail} />
        <Route path="/proposals" component={Proposals} />
        <Route path="/notifications" component={Notifications} />
        <Route path="/monitor" component={MonitorPage} />
        <Route path="/settings" component={SettingsPage} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
