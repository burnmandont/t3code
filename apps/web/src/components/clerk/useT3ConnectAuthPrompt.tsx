import { useCloudAuth } from "../../cloud/auth";

export function useT3ConnectAuthPrompt() {
  const { signIn } = useCloudAuth();
  const openAuthPrompt = () => {
    signIn(window.location.href);
  };
  return { authPrompt: null, openAuthPrompt };
}
