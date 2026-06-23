package capsule

import "strconv"

func composeMicroVMTransientUnit(manifest ExecutionManifest) (transientUnit, error) {
	if manifest.PackageClass != executePackageClassMicroVMService {
		return transientUnit{}, &ExecuteInvalidRequestError{Reason: "manifest.packageClass must be microvm-service"}
	}
	if err := manifest.Runtime.ValidateForPackageClass(executePackageClassMicroVMService); err != nil {
		return transientUnit{}, err
	}
	if len(manifest.Data.Volumes) > 0 || len(manifest.Data.Classes) > 0 {
		return transientUnit{}, &ExecuteInvalidRequestError{Reason: "microvm-service data volumes are not supported"}
	}

	unitName := capsuleUnitName(manifest.ID)
	limits := manifest.ResourceLimits
	properties := hardenedMicroVMTransientUnitProperties(manifest)
	properties = append(properties,
		systemdProperty{Name: "MemoryMax", Value: strconv.FormatInt(limits.RamMiB*1024*1024, 10)},
		systemdProperty{Name: "CPUQuota", Value: cpuQuota(limits.CPUCores)},
		systemdProperty{Name: "TasksMax", Value: strconv.FormatInt(limits.TasksMax, 10)},
	)

	argv := []string{
		defaultNspawnPath,
		"--directory=" + ociRootDirectory(manifest),
		"--private-users=pick",
		"-U",
		"--as-pid2",
		"--ephemeral",
		"--console=pipe",
		"--private-network",
		"--drop-capability=all",
		"--",
	}
	argv = append(argv, manifest.Runtime.OCI.Image.Entrypoint...)

	return transientUnit{
		Name:             unitName,
		Argv:             argv,
		Properties:       properties,
		MicroVMReadiness: &microVMReadinessProbe{ID: manifest.ID},
	}, nil
}

func hardenedMicroVMTransientUnitProperties(manifest ExecutionManifest) []systemdProperty {
	runtimeDir := capsuleRuntimeDirectory(manifest.ID) + "-nspawn"
	return []systemdProperty{
		{Name: "Description", Value: "Vita capsule " + manifest.ID + " microvm-service"},
		{Name: "Type", Value: "simple"},
		{Name: "StandardOutput", Value: "journal"},
		{Name: "StandardError", Value: "journal"},
		{Name: "AmbientCapabilities", Value: ""},
		{Name: "ProtectHome", Value: "yes"},
		{Name: "PrivateTmp", Value: "yes"},
		{Name: "ProtectKernelTunables", Value: "yes"},
		{Name: "ProtectKernelModules", Value: "yes"},
		{Name: "ProtectKernelLogs", Value: "yes"},
		{Name: "ProtectClock", Value: "yes"},
		{Name: "RestrictSUIDSGID", Value: "yes"},
		{Name: "RestrictNamespaces", Value: "mnt pid ipc uts user net cgroup"},
		{Name: "RestrictRealtime", Value: "yes"},
		{Name: "RestrictAddressFamilies", Value: "AF_UNIX AF_NETLINK"},
		{Name: "LockPersonality", Value: "yes"},
		{Name: "SystemCallArchitectures", Value: "native"},
		{Name: "Environment", Value: "TMPDIR=/run/" + runtimeDir},
		{Name: "RuntimeDirectory", Value: runtimeDir},
		{Name: "RuntimeDirectoryMode", Value: "0700"},
		{Name: "UMask", Value: "0077"},
	}
}
