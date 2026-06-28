use std::collections::HashMap;
use crate::projection::{ServerProjection, VaultDef};

#[derive(Debug, Clone)]
pub struct NamespaceDef {
    pub kind: String,
    pub shareable: bool,
    pub sensitive: bool,
    pub readonly: bool,
}

#[derive(Debug, Clone)]
pub struct RuntimeNamespaceDef {
    pub server_only: bool,
    pub built_in: bool,
}

#[derive(Debug, Clone)]
pub struct BootstrappedManifest {
    pub namespaces: HashMap<String, NamespaceDef>,
    pub runtime_namespaces: HashMap<String, RuntimeNamespaceDef>,
    pub frameworks: HashMap<String, String>,
    pub vaults: HashMap<String, VaultDef>,
}

pub fn default_namespace_defs() -> HashMap<String, NamespaceDef> {
    let mut m = HashMap::new();
    m.insert("value".into(), NamespaceDef { kind: "data".into(), shareable: true, sensitive: false, readonly: false });
    m.insert("secret".into(), NamespaceDef { kind: "data".into(), shareable: false, sensitive: true, readonly: false });
    m.insert("meta".into(), NamespaceDef { kind: "system".into(), shareable: false, sensitive: false, readonly: true });
    m.insert("process".into(), NamespaceDef { kind: "system".into(), shareable: false, sensitive: false, readonly: true });
    m.insert("public".into(), NamespaceDef { kind: "projection".into(), shareable: true, sensitive: false, readonly: true });
    m.insert("env".into(), NamespaceDef { kind: "projection".into(), shareable: true, sensitive: false, readonly: true });
    m
}

pub fn default_frameworks() -> HashMap<String, String> {
    let mut m = HashMap::new();
    m.insert("next".into(), "NEXT_PUBLIC_".into());
    m.insert("vite".into(), "VITE_".into());
    m.insert("nuxt".into(), "NUXT_PUBLIC_".into());
    m.insert("webpack".into(), "".into());
    m
}

pub fn bootstrapped_manifest_from_projection(projection: &ServerProjection) -> BootstrappedManifest {
    let mut namespaces = default_namespace_defs();
    for ns in &projection.meta.namespaces {
        namespaces.entry(ns.clone()).or_insert_with(|| NamespaceDef {
            kind: "data".into(), shareable: false, sensitive: false, readonly: false,
        });
    }

    let mut runtime_namespaces = HashMap::new();
    runtime_namespaces.insert("process".into(), RuntimeNamespaceDef { server_only: true, built_in: true });
    for ns in &projection.runtime_namespaces {
        if ns != "process" {
            runtime_namespaces.insert(ns.clone(), RuntimeNamespaceDef { server_only: true, built_in: false });
        }
    }

    BootstrappedManifest {
        namespaces,
        runtime_namespaces,
        frameworks: default_frameworks(),
        vaults: projection.vaults.clone(),
    }
}
