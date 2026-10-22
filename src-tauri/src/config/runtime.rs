use serde_yaml_ng::{Mapping, Value};
use smartstring::alias::String;
use std::collections::{HashMap, HashSet};

use crate::enhance::field::use_keys;

const PATCH_CONFIG_INNER: [&str; 5] = ["allow-lan", "ipv6", "log-level", "unified-delay", "tunnels"];

#[derive(Default, Clone)]
pub struct IRuntime {
    pub config: Option<Mapping>,
    pub(crate) dns_override: Option<super::dns::DnsOverrideState>,
    // Keys seen in the profile pipeline, including merge and script output.
    pub exists_keys: HashSet<String>,
    // TODO 或许可以用 FixMap 来存储以提升效率
    pub chain_logs: HashMap<String, Vec<(String, String)>>,
    pub(crate) proxy_chain_original_dialers: HashMap<String, Option<Value>>,
}

impl IRuntime {
    #[inline]
    pub fn patch_config(&mut self, patch: &Mapping) {
        let config = if let Some(config) = self.config.as_mut() {
            config
        } else {
            return;
        };

        for key in PATCH_CONFIG_INNER.iter() {
            if let Some(value) = patch.get(key) {
                config.insert((*key).into(), value.clone());
            }
        }

        let Some(patch_tun) = patch.get("tun") else {
            return;
        };

        let tun_key = Value::from("tun");
        if !matches!(config.get(&tun_key), Some(Value::Mapping(_))) {
            config.insert(tun_key.clone(), Value::Mapping(Mapping::new()));
        }

        if let (Some(patch_tun_mapping), Some(Value::Mapping(tun))) = (patch_tun.as_mapping(), config.get_mut(&tun_key))
        {
            for key in use_keys(patch_tun_mapping) {
                if let Some(value) = patch_tun_mapping.get(key.as_str()) {
                    tun.insert(Value::from(key.as_str()), value.clone());
                }
            }
        }
    }

    /// Applies a temporary chain without discarding user-defined `dialer-proxy` links.
    #[inline]
    pub fn update_proxy_chain_config(&mut self, proxy_chain_config: Option<Value>) {
        let config = if let Some(config) = self.config.as_mut() {
            config
        } else {
            return;
        };

        let Some(Value::Sequence(proxies)) = config.get_mut("proxies") else {
            return;
        };

        for (name, original) in self.proxy_chain_original_dialers.drain() {
            if let Some(Value::Mapping(proxy)) = proxies
                .iter_mut()
                .find(|proxy| proxy.get("name").and_then(Value::as_str) == Some(name.as_str()))
            {
                if let Some(original) = original {
                    proxy.insert("dialer-proxy".into(), original);
                } else {
                    proxy.remove("dialer-proxy");
                }
            }
        }

        if let Some(Value::Sequence(dialer_proxies)) = proxy_chain_config {
            for (i, dialer_proxy) in dialer_proxies.iter().enumerate() {
                if let Some(Value::Mapping(proxy)) =
                    proxies.iter_mut().find(|proxy| proxy.get("name") == Some(dialer_proxy))
                    && let Some(name) = dialer_proxy.as_str()
                {
                    self.proxy_chain_original_dialers
                        .entry(name.into())
                        .or_insert_with(|| proxy.get("dialer-proxy").cloned());

                    if i == 0 {
                        proxy.remove("dialer-proxy");
                    } else {
                        proxy.insert("dialer-proxy".into(), dialer_proxies[i - 1].clone());
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod proxy_chain_tests {
    use super::IRuntime;
    use serde_yaml_ng::{Mapping, Value};

    fn runtime() -> IRuntime {
        let config: Mapping = serde_yaml_ng::from_str(
            r#"proxies:
  - {name: entry, dialer-proxy: entry-upstream}
  - {name: exit, dialer-proxy: exit-upstream}
  - {name: next}
  - {name: local-service, dialer-proxy: user-group}
proxy-providers:
  local: {type: file, path: ./local.yaml, override: {dialer-proxy: provider-group}}
"#,
        )
        .unwrap();
        IRuntime {
            config: Some(config),
            ..Default::default()
        }
    }

    fn chain(names: &[&str]) -> Option<Value> {
        Some(Value::Sequence(names.iter().map(|name| Value::from(*name)).collect()))
    }

    fn dialer(runtime: &IRuntime, name: &str) -> Option<Value> {
        runtime.config.as_ref().unwrap()["proxies"]
            .as_sequence()
            .unwrap()
            .iter()
            .find(|proxy| proxy["name"].as_str() == Some(name))
            .unwrap()
            .get("dialer-proxy")
            .cloned()
    }

    #[test]
    fn exit_without_a_managed_chain_preserves_user_config() {
        let mut runtime = runtime();
        let original = runtime.config.clone();
        runtime.update_proxy_chain_config(None);
        assert_eq!(runtime.config, original);
    }

    #[test]
    fn chain_overrides_only_selected_nodes_and_restores_original_links() {
        let mut runtime = runtime();
        let original = runtime.config.clone();
        runtime.update_proxy_chain_config(chain(&["entry", "exit"]));
        assert_eq!(dialer(&runtime, "entry"), None);
        assert_eq!(dialer(&runtime, "exit"), Some(Value::from("entry")));
        assert_eq!(dialer(&runtime, "local-service"), Some(Value::from("user-group")));
        assert_eq!(
            runtime.config.as_ref().unwrap()["proxy-providers"],
            original.as_ref().unwrap()["proxy-providers"]
        );

        runtime.update_proxy_chain_config(None);
        assert_eq!(runtime.config, original);
        runtime.update_proxy_chain_config(None);
        assert_eq!(runtime.config, original);
    }

    #[test]
    fn repeated_and_replaced_chains_restore_user_links_and_remove_temporary_links() {
        let mut runtime = runtime();
        let original = runtime.config.clone();
        runtime.update_proxy_chain_config(chain(&["entry", "exit"]));
        runtime.update_proxy_chain_config(chain(&["entry", "exit"]));
        runtime.update_proxy_chain_config(chain(&["exit", "next"]));
        assert_eq!(dialer(&runtime, "entry"), Some(Value::from("entry-upstream")));
        assert_eq!(dialer(&runtime, "exit"), None);
        assert_eq!(dialer(&runtime, "next"), Some(Value::from("exit")));

        runtime.update_proxy_chain_config(None);
        assert_eq!(runtime.config, original);
    }
}
