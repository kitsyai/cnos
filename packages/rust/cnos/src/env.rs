use std::collections::HashMap;

pub struct CnosEnvironment {
    override_map: Option<HashMap<String, String>>,
}

impl CnosEnvironment {
    pub fn new(values: Option<HashMap<String, String>>) -> Self {
        CnosEnvironment { override_map: values }
    }

    pub fn get(&self, key: &str) -> Option<String> {
        match &self.override_map {
            Some(map) => map.get(key).cloned(),
            None => std::env::var(key).ok(),
        }
    }

    pub fn process_env(&self) -> Vec<String> {
        let mut values: HashMap<String, String> = std::env::vars().collect();
        if let Some(overrides) = &self.override_map {
            for (k, v) in overrides {
                values.insert(k.clone(), v.clone());
            }
        }
        values.into_iter().map(|(k, v)| format!("{}={}", k, v)).collect()
    }
}
