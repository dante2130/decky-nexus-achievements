import {
  ButtonItem,
  PanelSection,
  PanelSectionRow,
  SliderField,
  ToggleField,
  staticClasses,
} from "@decky/ui";
import { addEventListener, callable, definePlugin, removeEventListener, toaster } from "@decky/api";
import { useEffect, useState } from "react";
import { FaTrophy } from "react-icons/fa";

interface AchievementEvent {
  type: "achievement";
  ts: string;
  titleId: string;
  scid: string;
  id: string;
  name: string;
  description?: string;
  gamerscore?: number;
  iconUrl?: string;
}

interface Settings {
  enabled: boolean;
  duration: number;
  events_path: string;
  resolved_path?: string;
}

const getSettings = callable<[], Settings>("get_settings");
const setSettings = callable<[boolean, number, string], Settings>("set_settings");
const testNotification = callable<[], void>("test_notification");

// The toast runs in the Steam UI, so keep the duration locally.
let currentDuration = 8000;

function showAchievement(event: AchievementEvent) {
  const score = typeof event.gamerscore === "number" ? `${event.gamerscore} G` : "";
  const body = [event.description, score].filter(Boolean).join(" • ");
  const logo = event.iconUrl && /^https?:\/\//.test(event.iconUrl)
    ? <img src={event.iconUrl} style={{ width: 48, height: 48, borderRadius: 4 }} />
    : <FaTrophy />;
  toaster.toast({
    title: `Achievement unlocked: ${event.name}`,
    body,
    logo,
    duration: currentDuration,
    playSound: true,
    sound: 6,
    showToast: true,
  });
}

function Content() {
  const [settings, setLocal] = useState<Settings | null>(null);

  useEffect(() => {
    getSettings().then(s => { currentDuration = s.duration; setLocal(s); });
  }, []);

  if (!settings) return null;

  const update = async (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch };
    setLocal(next);
    currentDuration = next.duration;
    setLocal(await setSettings(next.enabled, next.duration, next.events_path));
  };

  return (
    <PanelSection title="Nexus Achievements">
      <PanelSectionRow>
        <ToggleField label="Enable notifications" checked={settings.enabled}
          onChange={enabled => update({ enabled })} />
      </PanelSectionRow>
      <PanelSectionRow>
        <SliderField label="Duration (seconds)" min={2} max={30} step={1}
          value={Math.round(settings.duration / 1000)} showValue
          onChange={seconds => update({ duration: seconds * 1000 })} />
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={() => testNotification()}>
          Send test notification
        </ButtonItem>
      </PanelSectionRow>
      <PanelSectionRow>
        <div style={{ fontSize: 11, opacity: 0.7, wordBreak: "break-all" }}>
          Watching: {settings.resolved_path}
        </div>
      </PanelSectionRow>
    </PanelSection>
  );
}

export default definePlugin(() => {
  getSettings().then(s => { currentDuration = s.duration; }).catch(() => {});
  const listener = addEventListener<[AchievementEvent]>("achievement", showAchievement);

  return {
    name: "Nexus Achievements",
    titleView: <div className={staticClasses.Title}>Nexus Achievements</div>,
    content: <Content />,
    icon: <FaTrophy />,
    onDismount() {
      removeEventListener("achievement", listener);
    },
  };
});
