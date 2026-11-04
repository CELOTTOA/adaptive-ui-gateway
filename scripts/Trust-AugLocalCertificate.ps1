param(
  [Parameter(Mandatory = $true)]
  [string]$ExpectedSha256
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$certPath = Join-Path $repoRoot '.local\tls\aug-localhost.cer'
$expected = $ExpectedSha256.Replace(':', '').ToUpperInvariant()
$actual = (Get-FileHash -LiteralPath $certPath -Algorithm SHA256).Hash
if ($expected -notmatch '^[A-F0-9]{64}$' -or $actual -ne $expected) {
  throw 'Certificate fingerprint mismatch. Trust was not changed.'
}
$certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($certPath)
$constraints = $certificate.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.19' }
if ($certificate.HasPrivateKey -or -not $constraints -or $constraints.CertificateAuthority -or
    $certificate.NotBefore -gt (Get-Date) -or $certificate.NotAfter -le (Get-Date)) {
  throw 'Expected a valid localhost leaf certificate without a private key. Trust was not changed.'
}

$privateKeyPath = Join-Path $repoRoot '.local\tls\aug-localhost.key.pem'
$userSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$allowedSids = @($userSid, 'S-1-5-18', 'S-1-5-32-544')
foreach ($protectedPath in @((Split-Path -Parent $privateKeyPath), $privateKeyPath)) {
  $acl = Get-Acl -LiteralPath $protectedPath
  $ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  $foreignRules = @($acl.Access | Where-Object {
    $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
    $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -notin $allowedSids
  })
  if ($ownerSid -notin $allowedSids -or $foreignRules.Count -gt 0) {
    throw 'Private key permissions are too broad. Regenerate in a private directory before approving trust. Trust was not changed.'
  }
}

# Run only after explicit approval of this exact certificate fingerprint.
# This installs the public certificate in the current user's trust store only.
Import-Certificate -FilePath $certPath -CertStoreLocation 'Cert:\CurrentUser\Root' |
  Select-Object Subject, Thumbprint, NotAfter
