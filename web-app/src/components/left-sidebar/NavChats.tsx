import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
} from "@/components/ui/sidebar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { MoreHorizontal, RefreshCw } from "lucide-react"
import { useMemo, useState } from "react"
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useThreads } from "@/hooks/useThreads"
import ThreadList from "@/containers/ThreadList"
import { DeleteAllThreadsDialog } from "@/containers/dialogs/DeleteAllThreadsDialog"
import { cn } from "@/lib/utils"

const groupActionClasses =
  "flex aspect-square w-5 items-center justify-center rounded-md p-0 text-sidebar-foreground outline-hidden ring-sidebar-ring transition-transform hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 disabled:opacity-50 disabled:cursor-not-allowed [&>svg]:size-4 [&>svg]:shrink-0 after:absolute after:-inset-2 md:after:hidden"

export function NavChats() {
  const { t } = useTranslation()
  const getFilteredThreads = useThreads((state) => state.getFilteredThreads)
  const threads = useThreads((state) => state.threads)
  const deleteAllThreads = useThreads((state) => state.deleteAllThreads)
  const refreshThreads = useThreads((state) => state.refreshThreads)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)

  const threadsWithoutProject = useMemo(() => {
    return getFilteredThreads('').filter((thread) => !thread.metadata?.project)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getFilteredThreads, threads])

  if (threadsWithoutProject.length === 0) {
    return null
  }

  const handleRefresh = async () => {
    setIsRefreshing(true)
    try {
      await refreshThreads()
    } finally {
      setIsRefreshing(false)
    }
  }

  return (
    <SidebarGroup className="group-data-[collapsible=icon]:hidden">
      <SidebarGroupLabel>{t('common:chats')}</SidebarGroupLabel>
      <div className="absolute right-3 top-3.5 flex items-center gap-0.5 group-data-[collapsible=icon]:hidden">
        <button
          type="button"
          onClick={handleRefresh}
          disabled={isRefreshing}
          title={t('common:refresh')}
          className={groupActionClasses}
        >
          <RefreshCw className={cn(isRefreshing && "animate-spin")} />
          <span className="sr-only">{t('common:refresh')}</span>
        </button>
        {threadsWithoutProject.length > 1 &&
          <DropdownMenu open={dropdownOpen} onOpenChange={setDropdownOpen}>
            <DropdownMenuTrigger asChild>
              <button className={cn(groupActionClasses, "hover:bg-sidebar-foreground/8")}>
                <MoreHorizontal className="text-muted-foreground" />
                <span className="sr-only">More</span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="right" align="start">
              <DeleteAllThreadsDialog
                onDeleteAll={deleteAllThreads}
                onDropdownClose={() => setDropdownOpen(false)}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        }
      </div>
      <SidebarMenu>
        <ThreadList threads={threadsWithoutProject} />
      </SidebarMenu>
    </SidebarGroup>
  )
}
