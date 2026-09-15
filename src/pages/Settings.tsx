import { useState } from 'react'
import { navigate } from '../App'
import { api } from '../lib/api'
import { posthog } from '../lib/posthog'
import { openCanvasTab } from '../lib/desktop'
import { ModelAccountPanel } from '../components/ModelAccount'
import { DesignWorkflowPanel } from '../components/DesignWorkflow'
import { AccountSettings } from '../components/AccountSettings'
import { ConnectedAgents } from '../components/ConnectedAgents'
import { AccountMenu, ConnectCard, IconBack, IconChevron, IconSpark, IconUser } from '../components/DashShell'
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs'
import { Button } from '../components/ui/button'
import { Wordmark } from '../components/ui/wordmark'
import { Card, CardDescription, CardHeader, CardTitle } from '../components/ui/card'
import {
  DashContent,
  DashHeader,
  DashLayout,
  DashMain,
  DashNavItem,
  DashSectionLabel,
  DashSidebar,
  DashSubtitle,
  DashTitle,
} from '../components/ui/dash'

type Pane = 'model' | 'account' | 'agents'

/**
 * Account settings: the model account agents can use for image generation and
 * repo recon, who you are, and the MCP clients connected as you. It is the
 * account-level home for all three, so the canvas surfaces can link here
 * instead of carrying their own copy.
 *
 * It wears the same shell as the home dashboard: same rail, same top bar, same
 * account menu. Only the rail's middle changes, to a settings sub-nav.
 */
export function Settings() {
  /* the sub-nav switches panes rather than scrolling to an anchor — on a page
     this short an anchor jump looks like nothing happened */
  const [pane, setPane] = useState<Pane>('model')
  /* arriving from a canvas should not cost you your place — only same-origin
     canvas paths are honoured */
  const from = new URLSearchParams(location.search).get('from')
  const back = from && /^\/c\/[A-Za-z0-9_-]+$/.test(from) ? from : '/'

  async function createCanvas() {
    const canvas = await api.createCanvas('Untitled canvas')
    posthog.capture('canvas_created')
    if (!openCanvasTab(canvas.id, canvas.name)) navigate(`/c/${canvas.id}`)
  }

  return (
    <DashLayout>
      <DashSidebar>
        <Wordmark size="sm" className="px-2 pb-5 text-[17px]" />

        <Button
          variant="ghost"
          className="w-full justify-start gap-[9px] rounded-[9px] px-[10px] py-2 text-[13px] text-ink-soft hover:bg-paper hover:text-ink"
          onClick={() => navigate(back)}
        >
          <IconBack /> {back === '/' ? 'Back to canvases' : 'Back to canvas'}
        </Button>

        <DashSectionLabel>Settings</DashSectionLabel>
        <nav className="flex flex-col gap-0.5">
          <DashNavItem icon={<IconSpark />} active={pane === 'model'} onClick={() => setPane('model')}>
            Model account
          </DashNavItem>
          <DashNavItem icon={<IconUser />} active={pane === 'account'} onClick={() => setPane('account')}>
            Your account
          </DashNavItem>
          <DashNavItem icon={<IconSpark />} active={pane === 'agents'} onClick={() => setPane('agents')}>
            Connected agents
          </DashNavItem>
        </nav>

        <div className="min-h-6 flex-1" />
        <ConnectCard />
      </DashSidebar>

      <DashMain>
        <DashHeader>
          <nav className="flex items-center gap-2 text-[13px] text-ink-faint" aria-label="Breadcrumb">
            <Button
              variant="link"
              size="sm"
              className="px-0 py-0 text-[13px] font-normal text-ink-faint hover:text-ink"
              onClick={() => navigate('/')}
            >
              Home
            </Button>
            <IconChevron />
            <b className="font-semibold text-ink">Settings</b>
          </nav>
          <span className="flex-1" />
          <Button variant="primary" className="min-h-10 max-xs:px-3 md:min-h-0" onClick={createCanvas}>
            <span className="max-xs:hidden">+ New canvas</span>
            <span className="hidden max-xs:inline">+ New</span>
          </Button>
          <AccountMenu />
        </DashHeader>

        <DashContent>
          <div className="flex items-start gap-4 md:items-end">
            <div>
              <DashTitle>
                {pane === 'model' ? 'Model account' : pane === 'account' ? 'Your account' : 'Connected agents'}
              </DashTitle>
              <DashSubtitle>
                {pane === 'model'
                  ? 'The model account your agents use for image generation and repo recon, on every canvas.'
                  : pane === 'account'
                    ? 'Who you are on every canvas — and how you get back into this one.'
                    : 'MCP clients acting as you — and how to cut one off.'}
              </DashSubtitle>
            </div>
          </div>

          <Tabs value={pane} onValueChange={(next) => setPane(next as Pane)} className="mt-4 flex md:hidden">
            <TabsList className="h-10 w-full border border-line bg-surface p-1 shadow-card">
              <TabsTrigger value="model">
                <IconSpark /> Model account
              </TabsTrigger>
              <TabsTrigger value="account">
                <IconUser /> Your account
              </TabsTrigger>
              <TabsTrigger value="agents">
                <IconSpark /> Connected agents
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {pane === 'model' ? (
            <>
              <Card className="mt-4 max-w-[1000px] overflow-hidden sm:mt-5">
                <CardHeader>
                  <CardTitle>Model account</CardTitle>
                  <CardDescription>
                    Agents connected over MCP use this account for image generation, repo recon and design distillation.
                    It runs on an account you connect — your ChatGPT subscription or an [OI] key.
                  </CardDescription>
                </CardHeader>
                <ModelAccountPanel />
              </Card>
              <Card className="mt-4 max-w-[1000px] overflow-hidden sm:mt-5">
                <CardHeader>
                  <CardTitle>Design workflow</CardTitle>
                  <CardDescription>
                    Runs a design brief through two models: the implementer writes the frame, the judge critiques it,
                    and the implementer iterates until it passes. The run_design_workflow tool runs the pair picked
                    here, taken from the provider's live model list.
                  </CardDescription>
                </CardHeader>
                <DesignWorkflowPanel />
              </Card>
            </>
          ) : pane === 'account' ? (
            <AccountSettings />
          ) : (
            <ConnectedAgents />
          )}
        </DashContent>
      </DashMain>
    </DashLayout>
  )
}
