use std::io::Read;
use ed25519_dalek::{SigningKey, VerifyingKey, Signature, Signer, Verifier};
fn unhex(s: &str) -> Vec<u8> { (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i+2],16).unwrap()).collect() }
fn hex(b: &[u8]) -> String { b.iter().map(|b| format!("{b:02x}")).collect() }
fn main() {
 let a: Vec<String> = std::env::args().collect();
 let mut raw = Vec::new(); std::io::stdin().read_to_end(&mut raw).unwrap();
 match a[1].as_str() {
  "canonical" => print!("{}", jcs_canonicalize::canonicalize(std::str::from_utf8(&raw).unwrap()).unwrap()),
  "sign" => { let seed: [u8;32] = unhex(&a[2]).try_into().unwrap(); print!("{}", hex(&SigningKey::from_bytes(&seed).sign(&raw).to_bytes())); },
  "public" => { let seed: [u8;32] = unhex(&a[2]).try_into().unwrap(); print!("{}", hex(SigningKey::from_bytes(&seed).verifying_key().as_bytes())); },
  "verify" => { let pk: [u8;32] = unhex(&a[2]).try_into().unwrap(); let vk=VerifyingKey::from_bytes(&pk).unwrap(); let sig=Signature::from_slice(&unhex(&a[3])).unwrap(); print!("{}", vk.verify(&raw,&sig).is_ok()); },
  _ => panic!("unknown probe")
 }
}
